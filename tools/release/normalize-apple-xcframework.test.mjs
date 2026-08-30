import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCanonicalXCFrameworkPlist } from './normalize-apple-xcframework.mjs';

const olderXcode = {
  AvailableLibraries: [
    {
      LibraryIdentifier: 'macos-arm64_x86_64',
      LibraryPath: 'libbota_device_sdk_ffi.a',
      HeadersPath: 'Headers',
      SupportedArchitectures: ['x86_64', 'arm64'],
      SupportedPlatform: 'macos',
    },
    {
      LibraryIdentifier: 'ios-arm64',
      LibraryPath: 'libbota_device_sdk_ffi.a',
      HeadersPath: 'Headers',
      SupportedArchitectures: ['arm64'],
      SupportedPlatform: 'ios',
    },
  ],
  CFBundlePackageType: 'XFWK',
  XCFrameworkFormatVersion: '1.0',
};

test('canonical XCFramework metadata is stable across Xcode plist variants', () => {
  const newerXcode = structuredClone(olderXcode);
  newerXcode.AvailableLibraries.reverse();
  for (const library of newerXcode.AvailableLibraries) {
    library.BinaryPath = library.LibraryPath;
  }

  const older = renderCanonicalXCFrameworkPlist(olderXcode);
  const newer = renderCanonicalXCFrameworkPlist(newerXcode);

  assert.equal(newer, older);
  assert.doesNotMatch(newer, /BinaryPath/);
  assert.ok(newer.indexOf('ios-arm64') < newer.indexOf('macos-arm64_x86_64'));
  assert.ok(newer.indexOf('<string>arm64</string>') < newer.indexOf('<string>x86_64</string>'));
});

test('canonical XCFramework metadata rejects incomplete libraries', () => {
  assert.throws(
    () => renderCanonicalXCFrameworkPlist({ AvailableLibraries: [{}] }),
    /invalid/,
  );
});
