import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

function normalizeType(value, sdkPath) {
  const normalizedRoot = resolve(sdkPath).split(sep).join('/');
  return value
    .split(sep)
    .join('/')
    .replaceAll(normalizedRoot, '<sdk>')
    .replace(/\s+/g, ' ')
    .trim();
}

function declarationKinds(declarations = []) {
  return [...new Set(declarations.map((declaration) => ts.SyntaxKind[declaration.kind]))].sort();
}

function isUnder(directory, path) {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory !== '' &&
    pathFromDirectory !== '..' &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !pathFromDirectory.startsWith(`.${sep}`)
  );
}

function hasNonPublicModifier(declaration) {
  const flags = ts.getCombinedModifierFlags(declaration);
  return Boolean(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

function isReadonlyMember(symbol, declarations) {
  if (
    declarations.some((declaration) =>
      Boolean(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly)
    )
  ) {
    return true;
  }
  const hasGetter = declarations.some((declaration) => ts.isGetAccessor(declaration));
  const hasSetter = declarations.some((declaration) => ts.isSetAccessor(declaration));
  return hasGetter && !hasSetter;
}

function formatSignatures(checker, type, kind, sdkPath, location) {
  if (!type) return [];
  return checker
    .getSignaturesOfType(type, kind)
    .map((signature) =>
      normalizeType(
        checker.signatureToString(signature, location, TYPE_FORMAT_FLAGS),
        sdkPath
      )
    )
    .sort();
}

function publicMembers(checker, type, sdkPath, sourceRoot, location) {
  if (!type) return [];
  const members = [];
  for (const member of checker.getPropertiesOfType(type)) {
    const ownedDeclarations = (member.declarations ?? []).filter((declaration) =>
      isUnder(sourceRoot, declaration.getSourceFile().fileName)
    );
    if (
      ownedDeclarations.length === 0 ||
      ownedDeclarations.some((declaration) => hasNonPublicModifier(declaration))
    ) {
      continue;
    }
    const memberLocation = ownedDeclarations[0] ?? location;
    const memberType = checker.getTypeOfSymbolAtLocation(member, memberLocation);
    members.push({
      name: member.getName(),
      optional: Boolean(member.flags & ts.SymbolFlags.Optional),
      readonly: isReadonlyMember(member, ownedDeclarations),
      declarationKinds: declarationKinds(ownedDeclarations),
      type: normalizeType(
        checker.typeToString(memberType, memberLocation, TYPE_FORMAT_FLAGS),
        sdkPath
      ),
    });
  }
  return members.sort((left, right) => left.name.localeCompare(right.name));
}

function formatExport(checker, exportedSymbol, sdkPath, sourceRoot, location) {
  const symbol = exportedSymbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(exportedSymbol)
    : exportedSymbol;
  const declarations = symbol.declarations ?? [];
  const symbolLocation = symbol.valueDeclaration ?? declarations[0] ?? location;
  const runtime = Boolean(symbol.flags & ts.SymbolFlags.Value);
  const hasDeclaredType = Boolean(symbol.flags & ts.SymbolFlags.Type);
  const valueType = runtime
    ? checker.getTypeOfSymbolAtLocation(symbol, symbolLocation)
    : undefined;
  const declaredType = hasDeclaredType
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : undefined;
  const memberType = declaredType ?? valueType;
  const result = {
    name: exportedSymbol.getName(),
    runtime,
    declarationKinds: declarationKinds(declarations),
    callSignatures: formatSignatures(
      checker,
      valueType ?? declaredType,
      ts.SignatureKind.Call,
      sdkPath,
      symbolLocation
    ),
    constructSignatures: formatSignatures(
      checker,
      valueType,
      ts.SignatureKind.Construct,
      sdkPath,
      symbolLocation
    ),
    members: publicMembers(checker, memberType, sdkPath, sourceRoot, symbolLocation),
  };
  if (valueType) {
    result.valueType = normalizeType(
      checker.typeToString(valueType, symbolLocation, TYPE_FORMAT_FLAGS),
      sdkPath
    );
  }
  if (declaredType) {
    result.declaredType = normalizeType(
      checker.typeToString(declaredType, symbolLocation, TYPE_FORMAT_FLAGS),
      sdkPath
    );
  }
  return result;
}

export function extractReactNativeApi(sdkPath) {
  const root = resolve(sdkPath);
  const configPath = resolve(root, 'tsconfig.build.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], diagnosticHost()));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost()));
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  // The SDK build gate owns diagnostics; this tool reads the accepted public
  // surface even when a newer compiler reports unrelated implementation drift.

  const entrypoint = resolve(root, 'src/index.ts');
  const sourceFile = program.getSourceFile(entrypoint);
  if (!sourceFile) throw new Error(`React Native SDK entrypoint not found: ${entrypoint}`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`React Native SDK module symbol not found: ${entrypoint}`);
  const sourceRoot = resolve(root, 'src');
  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => formatExport(checker, symbol, root, sourceRoot, sourceFile))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { exports };
}

function diagnosticHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };
}

export function surfaceDigest(surface) {
  return createHash('sha256').update(JSON.stringify(surface)).digest('hex');
}

function commandOutput(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function readPackage(sdkPath) {
  return JSON.parse(readFileSync(resolve(sdkPath, 'package.json'), 'utf8'));
}

export function buildReactNativeApiContract({
  sdkPath,
  expectedCommit,
  expectedVersion,
  allowDirty = false,
}) {
  const root = resolve(sdkPath);
  const sourceRevision = commandOutput('git', ['rev-parse', 'HEAD'], root);
  if (!sourceRevision.startsWith(expectedCommit)) {
    throw new Error(
      `React Native SDK revision ${sourceRevision} does not match ${expectedCommit}`
    );
  }
  const dirty = commandOutput('git', ['status', '--porcelain'], root);
  if (dirty && !allowDirty) {
    throw new Error(`React Native SDK checkout is dirty:\n${dirty}`);
  }
  const packageJson = readPackage(root);
  if (packageJson.name !== '@bota.dev/react-native-sdk') {
    throw new Error(`unexpected React Native package ${packageJson.name}`);
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `React Native SDK version ${packageJson.version} does not match ${expectedVersion}`
    );
  }
  const surface = extractReactNativeApi(root);
  return {
    schemaVersion: 1,
    package: packageJson.name,
    packageVersion: packageJson.version,
    sourceRevision,
    entrypoint: 'src/index.ts',
    surfaceDigest: surfaceDigest(surface),
    surface,
  };
}

export function writeReactNativeApiContract(options) {
  const contract = buildReactNativeApiContract(options);
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(contract, null, 2)}\n`);
  return contract;
}

function requireString(value, field, pattern) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
}

function assertSortedUnique(values, field) {
  const names = values.map((value) => value.name);
  const sorted = [...new Set(names)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify(sorted)) {
    throw new Error(`React Native API contract ${field} must be sorted and unique`);
  }
}

export function validateReactNativeApiContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('invalid React Native API contract document');
  }
  if (contract.schemaVersion !== 1) {
    throw new Error('invalid React Native API contract schemaVersion');
  }
  if (contract.package !== '@bota.dev/react-native-sdk') {
    throw new Error('invalid React Native API contract package');
  }
  requireString(contract.packageVersion, 'packageVersion', /^\d+\.\d+\.\d+$/);
  requireString(contract.sourceRevision, 'sourceRevision', /^[0-9a-f]{40}$/);
  if (contract.entrypoint !== 'src/index.ts') {
    throw new Error('invalid React Native API contract entrypoint');
  }
  requireString(contract.surfaceDigest, 'surfaceDigest', /^[0-9a-f]{64}$/);
  if (!contract.surface || !Array.isArray(contract.surface.exports)) {
    throw new Error('invalid React Native API contract surface');
  }
  assertSortedUnique(contract.surface.exports, 'exports');
  for (const exported of contract.surface.exports) {
    requireString(exported.name, 'export name');
    if (!Array.isArray(exported.members)) {
      throw new Error(`invalid React Native API contract members for ${exported.name}`);
    }
    assertSortedUnique(exported.members, `${exported.name} members`);
  }
  const actualDigest = surfaceDigest(contract.surface);
  if (contract.surfaceDigest !== actualDigest) {
    throw new Error(
      `React Native API contract surfaceDigest ${contract.surfaceDigest} does not match ${actualDigest}`
    );
  }
  return contract;
}

function apiDifference(expected, actual) {
  const expectedByName = new Map(expected.exports.map((entry) => [entry.name, entry]));
  const actualByName = new Map(actual.exports.map((entry) => [entry.name, entry]));
  const added = [...actualByName.keys()].filter((name) => !expectedByName.has(name)).sort();
  const removed = [...expectedByName.keys()].filter((name) => !actualByName.has(name)).sort();
  const changed = [...expectedByName.keys()]
    .filter(
      (name) =>
        actualByName.has(name) &&
        JSON.stringify(expectedByName.get(name)) !== JSON.stringify(actualByName.get(name))
    )
    .sort();
  return { added, removed, changed };
}

function formatDifference({ added, removed, changed }) {
  const parts = [];
  if (added.length > 0) parts.push(`added exports: ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`removed exports: ${removed.join(', ')}`);
  if (changed.length > 0) parts.push(`changed exports: ${changed.join(', ')}`);
  return parts.join('; ');
}

export function verifyReactNativeApiContract({ sdkPath, contract }) {
  const expected = validateReactNativeApiContract(
    typeof contract === 'string'
      ? JSON.parse(readFileSync(resolve(contract), 'utf8'))
      : contract
  );
  const packageJson = readPackage(resolve(sdkPath));
  if (packageJson.name !== expected.package) {
    throw new Error(`unexpected React Native package ${packageJson.name}`);
  }
  const actualSurface = extractReactNativeApi(sdkPath);
  const actualDigest = surfaceDigest(actualSurface);
  if (actualDigest !== expected.surfaceDigest) {
    const difference = formatDifference(apiDifference(expected.surface, actualSurface));
    throw new Error(
      `React Native public API does not match ${expected.packageVersion}: ${difference}`
    );
  }
  return {
    package: packageJson.name,
    packageVersion: packageJson.version,
    exportCount: actualSurface.exports.length,
    surfaceDigest: actualDigest,
  };
}

function parseArguments(argv) {
  const [command, ...args] = argv;
  const options = { command, allowDirty: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--sdk-path':
        options.sdkPath = args[++index];
        break;
      case '--expected-commit':
        options.expectedCommit = args[++index];
        break;
      case '--expected-version':
        options.expectedVersion = args[++index];
        break;
      case '--output':
        options.output = args[++index];
        break;
      case '--contract':
        options.contract = args[++index];
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`missing --${name.replaceAll(/[A-Z]/g, '-$&').toLowerCase()}`);
  }
}

function runCli(argv) {
  const options = parseArguments(argv);
  switch (options.command) {
    case 'capture': {
      requireOptions(options, [
        'sdkPath',
        'expectedCommit',
        'expectedVersion',
        'output',
      ]);
      const contract = writeReactNativeApiContract(options);
      console.log(
        `captured ${contract.package} ${contract.packageVersion}: ${contract.surface.exports.length} exports (${contract.surfaceDigest})`
      );
      return;
    }
    case 'verify': {
      requireOptions(options, ['sdkPath', 'contract']);
      const result = verifyReactNativeApiContract(options);
      console.log(
        `verified ${result.package} ${result.packageVersion}: ${result.exportCount} exports (${result.surfaceDigest})`
      );
      return;
    }
    case 'validate': {
      requireOptions(options, ['contract']);
      const contract = validateReactNativeApiContract(
        JSON.parse(readFileSync(resolve(options.contract), 'utf8'))
      );
      console.log(
        `validated ${contract.package} ${contract.packageVersion}: ${contract.surface.exports.length} exports (${contract.surfaceDigest})`
      );
      return;
    }
    default:
      throw new Error(
        'usage: react-native-api-contract <capture|verify|validate> [options]'
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
