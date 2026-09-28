import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { primaryFiles } from './normalize-central-repository.mjs';

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export async function stagePreserved({ input, output, version, sign }) {
  assert.match(version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/, 'invalid beta version');
  const names = primaryFiles('bota-app-sdk', version);
  const inputs = [];
  for (const name of names) {
    const bytes = await readFile(join(input, name));
    assert.equal(digest('sha256', bytes), (await readFile(join(input, `${name}.sha256`), 'utf8')).trim(),
      `preserved input checksum mismatch: ${name}`);
    inputs.push([name, bytes]);
  }
  // Refuse an existing staging directory. Successful signatures are preserved in
  // the release bundle; retries restore that bundle instead of signing again.
  await mkdir(output);
  const coordinate = join(output, 'dev/bota/bota-app-sdk');
  const directory = join(coordinate, version);
  await mkdir(directory, { recursive: true });
  const write = async (path, bytes) => {
    await writeFile(path, bytes, { flag: 'wx' });
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
      await writeFile(`${path}.${algorithm}`, digest(algorithm, bytes), { flag: 'wx' });
    }
  };
  for (const [name, bytes] of inputs) {
    await write(join(directory, name), bytes);
    await write(join(directory, `${name}.asc`), await sign(bytes));
  }
  await write(join(coordinate, 'maven-metadata.xml'), Buffer.from(
    `<metadata><groupId>dev.bota</groupId><artifactId>bota-app-sdk</artifactId><versioning><latest>${version}</latest><release>${version}</release><versions><version>${version}</version></versions></versioning></metadata>\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let keyHome;
  try {
    assert.equal(process.argv.length, 2, 'usage: node tools/android/sign-preserved.mjs');
    const key = process.env.ORG_GRADLE_PROJECT_signingInMemoryKey;
    const password = process.env.ORG_GRADLE_PROJECT_signingInMemoryKeyPassword;
    assert.ok(key && password, 'protected Android staging requires in-memory signing key and password');
    keyHome = await mkdtemp(join(tmpdir(), 'bota-preserved-signing-'));
    await chmod(keyHome, 0o700);
    const gpg = (args, input) => {
      const result = spawnSync('gpg', ['--homedir', keyHome, '--batch', '--no-tty', ...args],
        { input, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, 'GPG signing operation failed');
      return result.stdout;
    };
    gpg(['--import'], key);
    const version = (await readFile('sdk-version.toml', 'utf8')).match(/^version = "([^"]+)"/m)?.[1];
    await stagePreserved({ input: 'target/android-release', output: 'target/android-central-raw', version,
      sign: async bytes => {
        const input = join(keyHome, 'payload');
        await writeFile(input, bytes, { mode: 0o600 });
        const signature = gpg(['--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--armor',
          '--detach-sign', '--output', '-', input], `${password}\n`);
        const signaturePath = join(keyHome, 'signature.asc');
        await writeFile(signaturePath, signature);
        gpg(['--verify', signaturePath, input]);
        return signature;
      } });
    console.log('Signed the five preserved CI Maven inputs without rebuilding them.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (keyHome) await rm(keyHome, { recursive: true, force: true });
  }
}
