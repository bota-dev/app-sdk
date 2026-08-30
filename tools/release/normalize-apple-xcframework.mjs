import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a nonempty string`);
  }
  return value;
}

function stringEntry(key, value, indent) {
  const prefix = ' '.repeat(indent);
  return `${prefix}<key>${key}</key>\n${prefix}<string>${xmlEscape(value)}</string>\n`;
}

export function renderCanonicalXCFrameworkPlist(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.AvailableLibraries)) {
    throw new Error('AvailableLibraries must be an array');
  }

  const libraries = input.AvailableLibraries.map((library, index) => {
    if (!library || typeof library !== 'object' || !Array.isArray(library.SupportedArchitectures)) {
      throw new Error(`AvailableLibraries[${index}] is invalid`);
    }
    return {
      identifier: requireString(library.LibraryIdentifier, 'LibraryIdentifier'),
      path: requireString(library.LibraryPath, 'LibraryPath'),
      headersPath: requireString(library.HeadersPath, 'HeadersPath'),
      architectures: library.SupportedArchitectures
        .map((value) => requireString(value, 'SupportedArchitectures'))
        .sort(),
      platform: requireString(library.SupportedPlatform, 'SupportedPlatform'),
      variant: library.SupportedPlatformVariant === undefined
        ? undefined
        : requireString(library.SupportedPlatformVariant, 'SupportedPlatformVariant'),
    };
  }).sort((left, right) => left.identifier.localeCompare(right.identifier));

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  xml += '<plist version="1.0">\n<dict>\n';
  xml += '  <key>AvailableLibraries</key>\n  <array>\n';
  for (const library of libraries) {
    xml += '    <dict>\n';
    xml += stringEntry('HeadersPath', library.headersPath, 6);
    xml += stringEntry('LibraryIdentifier', library.identifier, 6);
    xml += stringEntry('LibraryPath', library.path, 6);
    xml += '      <key>SupportedArchitectures</key>\n      <array>\n';
    for (const architecture of library.architectures) {
      xml += `        <string>${xmlEscape(architecture)}</string>\n`;
    }
    xml += '      </array>\n';
    xml += stringEntry('SupportedPlatform', library.platform, 6);
    if (library.variant !== undefined) {
      xml += stringEntry('SupportedPlatformVariant', library.variant, 6);
    }
    xml += '    </dict>\n';
  }
  xml += '  </array>\n';
  xml += stringEntry('CFBundlePackageType', 'XFWK', 2);
  xml += stringEntry('XCFrameworkFormatVersion', '1.0', 2);
  xml += '</dict>\n</plist>\n';
  return xml;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error('usage: normalize-apple-xcframework.mjs INPUT_JSON OUTPUT_PLIST');
  }
  const parsed = JSON.parse(await readFile(input, 'utf8'));
  await writeFile(output, renderCanonicalXCFrameworkPlist(parsed));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
