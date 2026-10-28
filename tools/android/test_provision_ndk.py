"""Offline failure-path tests; no SDK, downloads or compiler execution."""
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location(
    "provision_ndk", pathlib.Path(__file__).with_name("provision_ndk.py")
)
ndk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ndk)


class ProvisionTests(unittest.TestCase):
    def test_wrong_revision_is_not_an_accepted_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "source.properties").write_text("Pkg.Revision = 27.3.13750724\n")
            with self.assertRaisesRegex(RuntimeError, "revision"):
                ndk.verify_install(root)

    def test_download_requires_both_exact_size_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "ndk.zip"
            path.write_bytes(b"wrong")
            with patch.object(ndk, "ARCHIVE_BYTES", 5), patch.object(ndk, "ARCHIVE_SHA256", "0" * 64):
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    ndk.verify_archive(path)
            with patch.object(ndk, "ARCHIVE_BYTES", 6):
                with self.assertRaisesRegex(RuntimeError, "size"):
                    ndk.verify_archive(path)

    def test_download_is_bounded_and_records_failed_transfer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            response = io.BytesIO(b"oversized")
            response.status = 200
            connection = Mock()
            connection.getresponse.return_value = response
            with patch.object(ndk.http.client, "HTTPSConnection", return_value=connection) as connect, patch.object(ndk, "ARCHIVE_BYTES", 3):
                with self.assertRaisesRegex(RuntimeError, "size"):
                    ndk.download_archive(root / "ndk.zip", root / "transfer.json")
            receipt = json.loads((root / "transfer.json").read_text())
            self.assertFalse(receipt["verified"])
            self.assertEqual(receipt["received_bytes"], 9)
            connection.request.assert_called_once_with("GET", "/android/repository/android-ndk-r28c-linux.zip")
            connection.close.assert_called_once()
            self.assertEqual(connect.call_args.args, ("dl.google.com",))
            context = connect.call_args.kwargs["context"]
            self.assertEqual(context.verify_mode, ndk.ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)

    def test_download_rejects_redirect_without_following_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            response = io.BytesIO(b"not an archive")
            response.status = 302
            connection = Mock()
            connection.getresponse.return_value = response
            with patch.object(ndk.http.client, "HTTPSConnection", return_value=connection):
                with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
                    ndk.download_archive(root / "ndk.zip", root / "transfer.json")
            receipt = json.loads((root / "transfer.json").read_text())
            self.assertFalse(receipt["verified"])
            self.assertEqual(receipt["received_bytes"], 0)

    def test_zip_rejects_traversal_link_escape_and_bad_root(self):
        for name, mode, body in [
            ("android-ndk-r28c/../../escape", 0o100644, b"x"),
            ("other/clang", 0o100755, b"x"),
            ("android-ndk-r28c/link", 0o120777, b"../../escape"),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                path = pathlib.Path(temporary) / "ndk.zip"
                with zipfile.ZipFile(path, "w") as archive:
                    info = zipfile.ZipInfo(name)
                    info.external_attr = mode << 16
                    archive.writestr(info, body)
                with self.assertRaises(RuntimeError):
                    ndk.validate_zip(path)

    def test_valid_pinned_archive_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "ndk.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("android-ndk-r28c/source.properties", "Pkg.Revision = 28.2.13676358\n")
            with patch.object(ndk, "ARCHIVE_BYTES", path.stat().st_size), patch.object(ndk, "ARCHIVE_SHA256", hashlib.sha256(path.read_bytes()).hexdigest()):
                ndk.verify_archive(path)
            ndk.validate_zip(path)

    def test_recovery_is_only_for_observed_zip_failure_on_linux(self):
        self.assertTrue(ndk.can_recover(1, "Error on ZipFile unknown archive", "Linux"))
        for code, output, system in [(0, "Error on ZipFile", "Linux"), (1, "license not accepted", "Linux"), (1, "connection refused", "Linux"), (1, "Error on ZipFile", "Darwin")]:
            self.assertFalse(ndk.can_recover(code, output, system))

    def test_wrong_toolchain_environment_cannot_change_pin(self):
        self.assertEqual(ndk.VERSION, "28.2.13676358")
        self.assertEqual(ndk.ARCHIVE_URL, "https://dl.google.com/android/repository/android-ndk-r28c-linux.zip")
        self.assertEqual(ndk.ARCHIVE_BYTES, 722261334)
        self.assertEqual(ndk.ARCHIVE_SHA1, "a7b54a5de87fecd125a17d54f73c446199e72a64")
        self.assertEqual(ndk.ARCHIVE_SHA256, "dfb20d396df28ca02a8c708314b814a4d961dc9074f9a161932746f815aa552f")

    def test_compiler_probe_uses_exact_root_and_checks_machine(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "source.properties").write_text("Pkg.Revision = 28.2.13676358\n")
            replies = [types.SimpleNamespace(stdout="Android clang"), types.SimpleNamespace(stdout=""),
                       types.SimpleNamespace(stdout="Machine: AArch64")]
            with patch.object(ndk.platform, "system", return_value="Linux"), patch.object(ndk.os, "access", return_value=True), patch.object(ndk, "run", side_effect=replies) as execute:
                result = ndk.verify_install(root)
            compiler = str(root / "toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang")
            self.assertEqual(result["compiler"], compiler)
            self.assertEqual(execute.call_args_list[1].args[0][:3], [compiler, "-Werror", "-c"])
            with patch.object(ndk.platform, "system", return_value="Linux"), patch.object(ndk.os, "access", return_value=True), patch.object(ndk, "run", return_value=types.SimpleNamespace(stdout="Machine: X86")):
                with self.assertRaisesRegex(RuntimeError, "AArch64"):
                    ndk.verify_install(root)

    def scenario(self, temporary):
        root = pathlib.Path(temporary)
        script = root / "repo/tools/android/provision_ndk.py"
        sdk = root / "sdk"
        manager = sdk / "cmdline-tools/latest/bin/sdkmanager"
        manager.parent.mkdir(parents=True)
        manager.write_text("fixture")
        manager.chmod(0o755)
        return root, script, sdk

    def test_verified_existing_install_exports_pin_without_manager(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, script, sdk = self.scenario(temporary)
            environment = {"ANDROID_HOME": str(sdk), "ANDROID_NDK_HOME": "wrong-runner-default", "GITHUB_ENV": str(root / "env")}
            with patch.object(ndk, "__file__", str(script)), patch.dict(ndk.os.environ, environment, clear=True), patch.object(ndk, "verify_install", return_value={"revision": ndk.VERSION}), patch.object(ndk, "install_with_manager") as install:
                ndk.main()
            install.assert_not_called()
            self.assertEqual((root / "env").read_text(), f"ANDROID_NDK_HOME={sdk / 'ndk' / ndk.VERSION}\nANDROID_NDK_ROOT={sdk / 'ndk' / ndk.VERSION}\n")

    def test_unrelated_failure_cannot_download_or_mutate(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, script, sdk = self.scenario(temporary)
            with patch.object(ndk, "__file__", str(script)), patch.dict(ndk.os.environ, {"ANDROID_HOME": str(sdk)}, clear=True), patch.object(ndk, "verify_install", side_effect=RuntimeError("missing")), patch.object(ndk, "install_with_manager", return_value=(1, "License not accepted")), patch.object(ndk, "download_archive") as download:
                with self.assertRaisesRegex(RuntimeError, "inapplicable"):
                    ndk.main()
            download.assert_not_called()

    def test_zip_failure_does_not_overwrite_existing_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, script, sdk = self.scenario(temporary)
            existing = sdk / "ndk" / ndk.VERSION
            existing.mkdir(parents=True)
            marker = existing / "retained"
            marker.write_text("unchanged")
            with patch.object(ndk, "__file__", str(script)), patch.dict(ndk.os.environ, {"ANDROID_HOME": str(sdk)}, clear=True), patch.object(ndk.platform, "system", return_value="Linux"), patch.object(ndk, "verify_install", side_effect=RuntimeError("incomplete")), patch.object(ndk, "install_with_manager", return_value=(1, "Error on ZipFile")), patch.object(ndk, "download_archive") as download:
                with self.assertRaisesRegex(RuntimeError, "Preserving"):
                    ndk.main()
            download.assert_not_called()
            self.assertEqual(marker.read_text(), "unchanged")

    def test_preexisting_broken_symlink_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, script, sdk = self.scenario(temporary)
            with patch.object(ndk, "__file__", str(script)), patch.dict(ndk.os.environ, {"ANDROID_HOME": str(sdk)}, clear=True), patch.object(ndk.platform, "system", return_value="Linux"), patch.object(ndk.pathlib.Path, "is_symlink", return_value=True), patch.object(ndk, "verify_install", side_effect=RuntimeError("missing")), patch.object(ndk, "install_with_manager", return_value=(1, "Error on ZipFile")), patch.object(ndk, "download_archive") as download:
                with self.assertRaisesRegex(RuntimeError, "Preserving"):
                    ndk.main()
            download.assert_not_called()

    def test_one_verified_recovery_and_registration_then_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, script, sdk = self.scenario(temporary)
            attempts = []
            def install_attempt(manager, evidence, suffix):
                attempts.append(suffix)
                if suffix == "initial":
                    metadata = sdk / "ndk" / ndk.VERSION / ".installer/.installData"
                    metadata.parent.mkdir(parents=True)
                    metadata.write_text("retained failed attempt")
                    return 1, "Error on ZipFile"
                return 0, "recognized"
            def unpack(argv, timeout):
                self.assertEqual(argv[0:2], ["unzip", "-q"])
                self.assertEqual(timeout, 300)
                (pathlib.Path(argv[-1]) / ndk.ARCHIVE_ROOT).mkdir(parents=True)
            with patch.object(ndk, "__file__", str(script)), patch.dict(ndk.os.environ, {"ANDROID_HOME": str(sdk)}, clear=True), patch.object(ndk.platform, "system", return_value="Linux"), patch.object(ndk, "verify_install", side_effect=[RuntimeError("missing"), {"revision": ndk.VERSION}, {"revision": ndk.VERSION}]) as verify, patch.object(ndk, "install_with_manager", side_effect=install_attempt) as install, patch.object(ndk, "download_archive") as download, patch.object(ndk, "validate_zip") as validate, patch.object(ndk, "run", side_effect=unpack):
                ndk.main()
            self.assertEqual(install.call_count, 2)
            self.assertEqual(download.call_count, 1)
            self.assertEqual(validate.call_count, 1)
            self.assertEqual(verify.call_args_list[-1].args[0], sdk / "ndk" / ndk.VERSION)
            preserved = list(sdk.glob(".bota-ndk-failed-*/*/.installer/.installData"))
            self.assertEqual(len(preserved), 1)
            self.assertEqual(preserved[0].read_text(), "retained failed attempt")
            self.assertEqual(attempts, ["initial", "registration"])


if __name__ == "__main__":
    unittest.main()
