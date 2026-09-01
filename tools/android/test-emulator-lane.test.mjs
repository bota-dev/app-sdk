import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const writeExecutable = async (path, contents) => {
  await writeFile(path, contents);
  await chmod(path, 0o755);
};

const executeWithDeadline = (path, arguments_, options, deadlineMilliseconds) =>
  new Promise((resolve) => {
    const child = spawn(path, arguments_, { ...options, detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, 'SIGKILL');
    }, deadlineMilliseconds);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });

test('reports emulator output when the process exits before ADB connects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bota-emulator-lane-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const platformTools = join(directory, 'platform-tools');
  const emulatorDirectory = join(directory, 'emulator');
  const commandLineTools = join(directory, 'cmdline-tools', 'latest', 'bin');
  await Promise.all([
    mkdir(platformTools, { recursive: true }),
    mkdir(emulatorDirectory, { recursive: true }),
    mkdir(commandLineTools, { recursive: true }),
  ]);

  await writeExecutable(
    join(platformTools, 'adb'),
    `#!/usr/bin/env bash
if [[ "$1" == "wait-for-device" ]]; then sleep 60; fi
if [[ "$1" == "get-state" ]]; then echo offline; fi
exit 0
`
  );
  await writeExecutable(
    join(emulatorDirectory, 'emulator'),
    `#!/usr/bin/env bash
set -euo pipefail
test -f "$ANDROID_AVD_HOME/bota-api-26.ini"
echo "emulator exploded" >&2
exit 42
`
  );
  await writeExecutable(
    join(commandLineTools, 'avdmanager'),
    `#!/usr/bin/env bash
set -euo pipefail
test -n "$ANDROID_AVD_HOME"
if [[ "$1" == "create" ]]; then
  mkdir -p "$ANDROID_AVD_HOME"
  touch "$ANDROID_AVD_HOME/bota-api-26.ini"
fi
exit 0
`
  );

  const result = await executeWithDeadline(
    'tools/android/test-emulator-lane.sh',
    ['--api', '26', '--public-only'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANDROID_SDK_ROOT: directory,
        BOTA_EMULATOR_ATTACH_ATTEMPTS: '3',
        BOTA_EMULATOR_POLL_SECONDS: '0.05',
      },
    },
    2_000
  );

  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /emulator exited before ADB connected/);
  assert.match(result.stderr, /emulator exploded/);
});
