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
const TYPE_ALIAS_FORMAT_FLAGS = TYPE_FORMAT_FLAGS | ts.TypeFormatFlags.InTypeAlias;

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

function publicMembers(
  checker,
  type,
  sdkPath,
  sourceRoot,
  location,
  includeInherited
) {
  if (!type) return [];
  const members = [];
  for (const member of checker.getPropertiesOfType(type)) {
    const declarations = member.declarations ?? [];
    const ownedDeclarations = declarations.filter((declaration) =>
      isUnder(sourceRoot, declaration.getSourceFile().fileName)
    );
    if (
      declarations.length === 0 ||
      (!includeInherited && ownedDeclarations.length === 0) ||
      declarations.some((declaration) => hasNonPublicModifier(declaration))
    ) {
      continue;
    }
    const contractDeclarations = includeInherited ? declarations : ownedDeclarations;
    const memberLocation = ownedDeclarations[0] ?? declarations[0] ?? location;
    const memberType = checker.getTypeOfSymbolAtLocation(member, memberLocation);
    members.push({
      name: member.getName(),
      optional: Boolean(member.flags & ts.SymbolFlags.Optional),
      readonly: isReadonlyMember(member, contractDeclarations),
      declarationKinds: declarationKinds(contractDeclarations),
      type: normalizeType(
        checker.typeToString(memberType, memberLocation, TYPE_FORMAT_FLAGS),
        sdkPath
      ),
    });
  }
  return members.sort((left, right) => left.name.localeCompare(right.name));
}

function hasClassDeclaration(type) {
  return Boolean(
    type?.getSymbol()?.declarations?.some((declaration) => ts.isClassDeclaration(declaration))
  );
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
  const isClassExport = declarations.some((declaration) => ts.isClassDeclaration(declaration));
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
    members: publicMembers(
      checker,
      memberType,
      sdkPath,
      sourceRoot,
      symbolLocation,
      hasClassDeclaration(memberType)
    ),
    staticMembers: isClassExport
      ? publicMembers(
          checker,
          valueType,
          sdkPath,
          sourceRoot,
          symbolLocation,
          false
        )
      : [],
  };
  if (valueType) {
    result.valueType = normalizeType(
      checker.typeToString(valueType, symbolLocation, TYPE_FORMAT_FLAGS),
      sdkPath
    );
  }
  if (declaredType) {
    const typeFlags = declarations.some((declaration) => ts.isTypeAliasDeclaration(declaration))
      ? TYPE_ALIAS_FORMAT_FLAGS
      : TYPE_FORMAT_FLAGS;
    result.declaredType = normalizeType(
      checker.typeToString(declaredType, symbolLocation, typeFlags),
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
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new Error(`invalid React Native API contract ${field}`);
  }
}

function requireStringArray(values, field) {
  if (!Array.isArray(values)) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
  for (const value of values) requireString(value, field);
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(values) !== JSON.stringify(sorted)) {
    throw new Error(`React Native API contract ${field} must be sorted and unique`);
  }
}

function assertSortedUniqueNamed(values, field) {
  if (!Array.isArray(values)) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
  const names = values.map((value) => value.name);
  const sorted = [...new Set(names)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify(sorted)) {
    throw new Error(`React Native API contract ${field} must be sorted and unique`);
  }
}

function validateMember(member, field) {
  if (!member || typeof member !== 'object' || Array.isArray(member)) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
  requireString(member.name, `${field} name`);
  requireBoolean(member.optional, `${field} optional`);
  requireBoolean(member.readonly, `${field} readonly`);
  requireStringArray(member.declarationKinds, `${field} declarationKinds`);
  requireString(member.type, `${field} type`);
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
  assertSortedUniqueNamed(contract.surface.exports, 'exports');
  for (const exported of contract.surface.exports) {
    requireString(exported.name, 'export name');
    requireBoolean(exported.runtime, `${exported.name} runtime`);
    requireStringArray(
      exported.declarationKinds,
      `${exported.name} declarationKinds`
    );
    requireStringArray(exported.callSignatures, `${exported.name} callSignatures`);
    requireStringArray(
      exported.constructSignatures,
      `${exported.name} constructSignatures`
    );
    if ('valueType' in exported) {
      requireString(exported.valueType, `${exported.name} valueType`);
    }
    if ('declaredType' in exported) {
      requireString(exported.declaredType, `${exported.name} declaredType`);
    }
    assertSortedUniqueNamed(exported.members, `${exported.name} members`);
    assertSortedUniqueNamed(
      exported.staticMembers,
      `${exported.name} staticMembers`
    );
    for (const member of exported.members) {
      validateMember(member, `${exported.name}.${member.name}`);
    }
    for (const member of exported.staticMembers) {
      validateMember(member, `${exported.name}.${member.name}`);
    }
  }
  const actualDigest = surfaceDigest(contract.surface);
  if (contract.surfaceDigest !== actualDigest) {
    throw new Error(
      `React Native API contract surfaceDigest ${contract.surfaceDigest} does not match ${actualDigest}`
    );
  }
  return contract;
}

export function validateReactNativeApiBaseline({
  contract,
  metadata,
  contractPath,
}) {
  const validContract = validateReactNativeApiContract(contract);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('invalid React Native baseline metadata');
  }
  if (metadata.packageVersion !== validContract.packageVersion) {
    throw new Error('React Native baseline metadata packageVersion does not match contract');
  }
  if (metadata.publicApi?.contract !== contractPath) {
    throw new Error('React Native baseline metadata contract path does not match contract');
  }
  if (metadata.publicApi?.surfaceDigest !== validContract.surfaceDigest) {
    throw new Error('React Native baseline metadata surfaceDigest does not match contract');
  }
  return validContract;
}

function memberDifference(exportName, expected, actual, key) {
  const expectedByName = new Map(expected[key].map((entry) => [entry.name, entry]));
  const actualByName = new Map(actual[key].map((entry) => [entry.name, entry]));
  const qualify = (name) => `${exportName}.${name}`;
  return {
    added: [...actualByName.keys()]
      .filter((name) => !expectedByName.has(name))
      .map(qualify),
    removed: [...expectedByName.keys()]
      .filter((name) => !actualByName.has(name))
      .map(qualify),
    changed: [...expectedByName.keys()]
      .filter(
        (name) =>
          actualByName.has(name) &&
          JSON.stringify(expectedByName.get(name)) !==
            JSON.stringify(actualByName.get(name))
      )
      .map(qualify),
  };
}

function exportWithoutMembers(exported) {
  const { members: _members, staticMembers: _staticMembers, ...rest } = exported;
  return rest;
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
        JSON.stringify(exportWithoutMembers(expectedByName.get(name))) !==
          JSON.stringify(exportWithoutMembers(actualByName.get(name)))
    )
    .sort();
  const memberChanges = [...expectedByName.keys()]
    .filter((name) => actualByName.has(name))
    .flatMap((name) => [
      memberDifference(
        name,
        expectedByName.get(name),
        actualByName.get(name),
        'members'
      ),
      memberDifference(
        name,
        expectedByName.get(name),
        actualByName.get(name),
        'staticMembers'
      ),
    ]);
  return {
    added,
    removed,
    changed,
    addedMembers: memberChanges.flatMap((entry) => entry.added).sort(),
    removedMembers: memberChanges.flatMap((entry) => entry.removed).sort(),
    changedMembers: memberChanges.flatMap((entry) => entry.changed).sort(),
  };
}

function formatDifference({
  added,
  removed,
  changed,
  addedMembers,
  removedMembers,
  changedMembers,
}) {
  const parts = [];
  if (added.length > 0) parts.push(`added exports: ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`removed exports: ${removed.join(', ')}`);
  if (changed.length > 0) parts.push(`changed exports: ${changed.join(', ')}`);
  if (addedMembers.length > 0) {
    parts.push(`added members: ${addedMembers.join(', ')}`);
  }
  if (removedMembers.length > 0) {
    parts.push(`removed members: ${removedMembers.join(', ')}`);
  }
  if (changedMembers.length > 0) {
    parts.push(`changed members: ${changedMembers.join(', ')}`);
  }
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
      case '--baseline-metadata':
        options.baselineMetadata = args[++index];
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
      requireOptions(options, ['contract', 'baselineMetadata']);
      const contract = validateReactNativeApiBaseline({
        contract: JSON.parse(readFileSync(resolve(options.contract), 'utf8')),
        metadata: JSON.parse(
          readFileSync(resolve(options.baselineMetadata), 'utf8')
        ),
        contractPath: options.contract,
      });
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
