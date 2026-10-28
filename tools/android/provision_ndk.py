"""Provision the frozen NDK; never substitute the runner's default NDK.

Normal installation/acceptance remains sdkmanager's responsibility. Only its
observed Linux ZipFile failure permits one verified official-archive recovery.
"""
import hashlib
import http.client
import json
import os
import pathlib
import platform
import posixpath
import shutil
import stat
import ssl
import subprocess
import sys
import tempfile
import time
import zipfile

VERSION = "28.2.13676358"
# Google's repository2-{1,3}.xml and android/ndk Unsupported-Downloads r28c.
ARCHIVE_URL = "https://dl.google.com/android/repository/android-ndk-r28c-linux.zip"
ARCHIVE_BYTES = 722261334
ARCHIVE_SHA1 = "a7b54a5de87fecd125a17d54f73c446199e72a64"
# Full official archive: published size/SHA-1 and every ZIP CRC verified before
# deriving this stronger runtime pin. SHA-1 is provenance metadata, not used here.
ARCHIVE_SHA256 = "dfb20d396df28ca02a8c708314b814a4d961dc9074f9a161932746f815aa552f"
ARCHIVE_ROOT = "android-ndk-r28c"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run(argv, timeout=60):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=timeout)


def verify_install(root):
    properties = root / "source.properties"
    if not properties.is_file():
        raise RuntimeError(f"NDK source.properties missing: {root}")
    revisions = [line.split("=", 1)[1].strip() for line in properties.read_text().splitlines()
                 if line.split("=", 1)[0].strip() == "Pkg.Revision" and "=" in line]
    if revisions != [VERSION]:
        raise RuntimeError(f"NDK revision mismatch at {root}: {revisions}")
    host = {"Linux": "linux-x86_64", "Darwin": "darwin-x86_64"}.get(platform.system())
    if host is None:
        raise RuntimeError("Pinned NDK provisioning requires Linux or macOS")
    toolchain = root / "toolchains/llvm/prebuilt" / host / "bin"
    for tool in ["aarch64-linux-android26-clang", "armv7a-linux-androideabi26-clang",
                 "x86_64-linux-android26-clang", "i686-linux-android26-clang", "llvm-nm", "llvm-readelf"]:
        if not os.access(toolchain / tool, os.X_OK):
            raise RuntimeError(f"Missing executable pinned NDK tool: {toolchain / tool}")
    compiler = toolchain / "aarch64-linux-android26-clang"
    version = run([str(compiler), "--version"]).stdout
    with tempfile.TemporaryDirectory(prefix="bota-ndk-probe-") as temporary:
        source = pathlib.Path(temporary) / "probe.c"
        output = pathlib.Path(temporary) / "probe.o"
        source.write_text("int bota_ndk_probe(void) { return 28; }\n")
        run([str(compiler), "-Werror", "-c", str(source), "-o", str(output)])
        header = run([str(toolchain / "llvm-readelf"), "--file-header", str(output)]).stdout
        if "AArch64" not in header:
            raise RuntimeError("Pinned NDK compiler did not produce an AArch64 object")
    return {"revision": VERSION, "root": str(root), "compiler": str(compiler),
            "compiler_version": version, "probe_elf_header": header}


def verify_archive(path):
    if path.stat().st_size != ARCHIVE_BYTES:
        raise RuntimeError("Official NDK archive size mismatch")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("Official NDK archive checksum mismatch")


def download_archive(path, receipt):
    digest = hashlib.sha256()
    received = 0
    started = time.monotonic()
    verified = False
    # Fixed Google origin; explicit default context verifies chain and hostname.
    # nosemgrep: python.lang.security.audit.httpsconnection-detected.httpsconnection-detected
    connection = http.client.HTTPSConnection("dl.google.com", timeout=60,
                                            context=ssl.create_default_context())
    try:
        # Fixed HTTPS origin/path, verified TLS and no redirects or alternate schemes.
        connection.request("GET", "/android/repository/android-ndk-r28c-linux.zip")
        with connection.getresponse() as response, path.open("xb") as output:
            if response.status != 200:
                raise RuntimeError(f"Official NDK download returned HTTP {response.status}")
            while block := response.read(1024 * 1024):
                received += len(block)
                digest.update(block)
                if received > ARCHIVE_BYTES:
                    raise RuntimeError("Official NDK transfer exceeds pinned size")
                if time.monotonic() - started > 720:
                    raise RuntimeError("Official NDK transfer exceeds 12-minute limit")
                output.write(block)
        verify_archive(path)
        verified = True
    finally:
        connection.close()
        write_json(receipt, {"url": ARCHIVE_URL, "expected_bytes": ARCHIVE_BYTES,
                            "published_sha1": ARCHIVE_SHA1, "expected_sha256": ARCHIVE_SHA256,
                            "received_bytes": received, "received_sha256": digest.hexdigest(),
                            "verified": verified})


def validate_zip(path):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if not members or len(members) > 20000 or sum(item.file_size for item in members) > 8 * 1024**3:
            raise RuntimeError("Unexpected NDK ZIP member count/size")
        seen = set()
        for item in members:
            name = item.filename.rstrip("/")
            parts = pathlib.PurePosixPath(name).parts
            if (not parts or parts[0] != ARCHIVE_ROOT or ".." in parts or "\\" in name
                    or pathlib.PurePosixPath(name).as_posix() != name
                    or name.startswith("/") or name in seen or len(name) > 1024):
                raise RuntimeError("Unexpected NDK ZIP member path")
            seen.add(name)
            mode = item.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise RuntimeError("Unexpected NDK ZIP member type")
            if stat.S_ISLNK(mode):
                if item.file_size > 4096:
                    raise RuntimeError("Oversized NDK ZIP link")
                target = archive.read(item).decode("utf-8")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if target.startswith("/") or "\\" in target or not resolved.startswith(ARCHIVE_ROOT + "/"):
                    raise RuntimeError("Escaping NDK ZIP link")
        if archive.testzip() is not None:
            raise RuntimeError("NDK ZIP CRC validation failed")


def can_recover(code, output, system):
    return code != 0 and system == "Linux" and "Error on ZipFile" in output


def install_with_manager(manager, evidence, suffix):
    result = subprocess.run([str(manager), "--verbose", f"ndk;{VERSION}"],
                            capture_output=True, text=True, timeout=900)
    output = result.stdout + result.stderr
    (evidence / f"sdkmanager-{suffix}.log").write_text(output, encoding="utf-8")
    print(output, flush=True)
    return result.returncode, output


def main():
    sdk = pathlib.Path(os.environ.get("ANDROID_SDK_ROOT") or os.environ["ANDROID_HOME"]).resolve()
    root = sdk / "ndk" / VERSION
    evidence = pathlib.Path(__file__).resolve().parents[2] / "target/android-ndk-provision"
    evidence.mkdir(parents=True, exist_ok=True)
    manager = sdk / "cmdline-tools/latest/bin/sdkmanager"
    if not os.access(manager, os.X_OK):
        raise RuntimeError(f"sdkmanager missing: {manager}")
    root_existed_before = root.exists() or root.is_symlink()
    try:
        identity = verify_install(root)
        method = "verified-existing"
    except RuntimeError:
        code, output = install_with_manager(manager, evidence, "initial")
        method = "sdkmanager"
        if code:
            if not can_recover(code, output, platform.system()):
                raise RuntimeError(f"NDK sdkmanager failed ({code}); recovery is inapplicable")
            # The manager can create .installer metadata before preparing ZIP
            # contents. Preserve this command's new partial tree by atomic rename;
            # never move/delete an installation that predates this invocation.
            if root_existed_before:
                raise RuntimeError(f"Preserving existing incomplete NDK tree: {root}")
            if root.is_symlink() or (root.exists() and not root.is_dir()):
                raise RuntimeError("Unexpected newly created NDK destination type")
            if root.exists():
                holder = pathlib.Path(tempfile.mkdtemp(prefix=".bota-ndk-failed-", dir=sdk))
                preserved = holder / VERSION
                root.rename(preserved)
                write_json(evidence / "failed-install.json", {
                    "created_by_this_sdkmanager_attempt": True,
                    "original_path": str(root), "preserved_path": str(preserved),
                    "deleted_or_overwritten": False,
                })
            root.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="bota-ndk-", dir=root.parent) as temporary:
                staging = pathlib.Path(temporary)
                archive = staging / "ndk.zip"
                download_archive(archive, evidence / "transfer.json")
                validate_zip(archive)
                run(["unzip", "-q", str(archive), "-d", str(staging / "unpacked")], timeout=300)
                candidate = staging / "unpacked" / ARCHIVE_ROOT
                verify_install(candidate)
                candidate.rename(root)
            # Register/recognize the legacy source.properties package through the
            # normal manager after its initial license-checked install failed.
            code, _ = install_with_manager(manager, evidence, "registration")
            if code:
                raise RuntimeError("sdkmanager did not recognize the verified pinned recovery")
            method = "verified-official-archive-recovery"
        identity = verify_install(root)
    identity["method"] = method
    identity["inherited_android_ndk_home"] = os.environ.get("ANDROID_NDK_HOME")
    write_json(evidence / "identity.json", identity)
    print(json.dumps(identity, indent=2), flush=True)
    if "GITHUB_ENV" in os.environ:
        if "\n" in str(root) or "\r" in str(root):
            raise RuntimeError("Invalid NDK environment path")
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
            output.write(f"ANDROID_NDK_HOME={root}\nANDROID_NDK_ROOT={root}\n")


if __name__ == "__main__":
    if sys.argv[1:] != [f"ndk;{VERSION}"]:
        raise RuntimeError(f"Expected the exact package ndk;{VERSION}")
    main()
