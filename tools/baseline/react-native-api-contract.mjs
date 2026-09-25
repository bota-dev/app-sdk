import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import ts from 'typescript';

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature;
const TYPE_ALIAS_FORMAT_FLAGS = TYPE_FORMAT_FLAGS | ts.TypeFormatFlags.InTypeAlias;
const UNRESOLVED_DEPENDENCY_DIAGNOSTIC_CODES = new Set([2307, 2688, 2792, 7016]);

function normalizeType(value, sdkPath) {
  const normalizedRoot = resolve(sdkPath).split(sep).join('/');
  return value
    .split(sep)
    .join('/')
    .replaceAll(normalizedRoot, '<sdk>')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifyLockedDependencies(root) {
  const failure = (detail) => {
    throw new Error(
      `React Native SDK dependencies do not match package-lock.json; run npm ci (${detail})`
    );
  };
  let expectedLock;
  let installedLock;
  try {
    expectedLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
    installedLock = JSON.parse(
      readFileSync(resolve(root, 'node_modules/.package-lock.json'), 'utf8')
    );
  } catch {
    failure('lock state is missing or invalid');
  }
  if (expectedLock.lockfileVersion !== installedLock.lockfileVersion) {
    failure('lockfile versions differ');
  }
  const expectedPackages = Object.entries(expectedLock.packages ?? {})
    .filter(([path]) => path !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedByPath = new Map(expectedPackages);
  const installedPackages = installedLock.packages ?? {};
  const installedPaths = Object.keys(installedPackages).sort((left, right) =>
    left.localeCompare(right)
  );
  const unexpectedPath = installedPaths.find((path) => !expectedByPath.has(path));
  if (unexpectedPath) {
    failure(`${unexpectedPath} is not in package-lock.json`);
  }
  for (const [path, expected] of expectedPackages) {
    const installed = installedPackages[path];
    if (!installed) {
      if (expected.optional) continue;
      failure(`${path} is not installed`);
    }
    for (const field of ['version', 'resolved', 'integrity', 'link']) {
      if (expected[field] !== installed[field]) {
        failure(`${path} ${field} differs`);
      }
    }
    if (expected.version) {
      const installedPackagePath = resolve(root, path, 'package.json');
      if (!existsSync(installedPackagePath)) {
        if (expected.optional) continue;
        failure(`${path} package.json is missing`);
      }
      let actualVersion;
      try {
        actualVersion = JSON.parse(
          readFileSync(installedPackagePath, 'utf8')
        ).version;
      } catch {
        failure(`${path} package.json is invalid`);
      }
      if (actualVersion !== expected.version) {
        failure(`${path} installed version differs`);
      }
    }
  }
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
          true
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
  const unresolvedDependencies = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) =>
      UNRESOLVED_DEPENDENCY_DIAGNOSTIC_CODES.has(diagnostic.code)
    );
  if (unresolvedDependencies.length > 0) {
    throw new Error(
      `React Native API extraction has unresolved dependencies:\n${ts.formatDiagnosticsWithColorAndContext(
        unresolvedDependencies,
        diagnosticHost()
      )}`
    );
  }
  verifyLockedDependencies(root);
  // The SDK build gate owns other diagnostics; this tool reads the accepted
  // public surface even when a newer compiler reports implementation drift.

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

function normalizeLiteralUnionOrder(value) {
  if (Array.isArray(value)) return value.map(normalizeLiteralUnionOrder);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, normalizeLiteralUnionOrder(child)]));
  }
  return typeof value === 'string' && /^"[^"]+"(?: \| "[^"]+")+$/.test(value)
    ? value.split(' | ').sort().join(' | ')
    : value;
}

export function validateCompatibleReactNativeSurface({ frozen, surface, additions }) {
  const expected = structuredClone(frozen);
  const errors = [];
  const byName = new Map(expected.exports.map((entry) => [entry.name, entry]));
  for (const [name, members] of Object.entries(additions.members)) {
    const entry = byName.get(name);
    if (!entry) {
      errors.push(`${name}: addition has no frozen export`);
      continue;
    }
    for (const member of members) {
      if (entry.members.some((old) => old.name === member.name)) {
        errors.push(`${name}.${member.name}: cannot overwrite a frozen member`);
      } else if (!member.optional && !member.declarationKinds.includes('MethodDeclaration')) {
        errors.push(`${name}.${member.name}: addition must be an optional property or method`);
      } else {
        entry.members.push(member);
      }
    }
    entry.members.sort((a, b) => a.name.localeCompare(b.name));
  }
  for (const [name, signatures] of Object.entries(additions.constructSignatures)) {
    const entry = byName.get(name);
    if (!entry) errors.push(`${name}: overload has no frozen export`);
    else entry.constructSignatures.push(...signatures);
  }
  for (const entry of additions.exports) {
    if (byName.has(entry.name)) errors.push(`${entry.name}: cannot replace a frozen export`);
    else {
      expected.exports.push(entry);
      byName.set(entry.name, entry);
    }
  }
  const actual = new Map(surface.exports.map((entry) => [entry.name, entry]));
  for (const entry of expected.exports) {
    const found = actual.get(entry.name);
    const normalize = (value) => value && normalizeLiteralUnionOrder({
      ...value,
      constructSignatures: [...value.constructSignatures].sort(),
      members: [...value.members].sort((a, b) => a.name.localeCompare(b.name)),
    });
    if (!isDeepStrictEqual(normalize(entry), normalize(found))) {
      errors.push(`${entry.name}: public surface differs from frozen contract plus enumerated maintenance additions`);
    }
  }
  return errors;
}

export function validateMaintenanceSelection({ contract, compatibility, expectedRevision }) {
  const errors = [];
  for (const [key, label] of [
    ['reactNativeMaintenanceBaseline', 'maintenance'],
    ['reactNativeWorkflowBaseline', 'workflow'],
  ]) {
    const selected = compatibility[key];
    if (!selected || selected.version !== contract.packageVersion ||
        selected.revision !== contract.sourceRevision || !/^[a-f0-9]{40}$/.test(selected.revision)) {
      errors.push(`${label} selection does not match the pinned maintenance contract`);
    }
  }
  if (expectedRevision !== undefined && expectedRevision !== contract.sourceRevision) {
    errors.push('explicit audit revision does not match the pinned maintenance contract; review source selection');
  }
  return errors;
}

export function validateMaintenanceSource({ contract, source, toolchain }) {
  const errors = [];
  for (const field of ['package', 'packageVersion', 'sourceRevision', 'surfaceDigest']) {
    if (contract[field] !== source[field]) errors.push(`maintenance source ${field} differs`);
  }
  if (!isDeepStrictEqual(contract.toolchain, toolchain)) {
    errors.push('maintenance source toolchain or dependency lock differs');
  }
  return errors;
}

const MAINTENANCE_EXPORTS = [
  'DeviceDiagnosticEvent', 'DeviceDiagnosticEventType', 'DeviceDiagnosticReasonCode',
  'DeviceDiagnosticsBatch', 'DeviceDiagnosticsDecoder', 'diagnosticEventIdCommand',
  'RecordingDataStore', 'RecordingManagerOptions', 'UPLOAD_RECOVERY_VERSION',
  'UploadRecoveryContext', 'UploadRecoveryProvider',
];
const MAINTENANCE_MEMBERS = {
  BotaConfig: ['recordingDataStore', 'uploadRecoveryProvider'],
  DeviceManager: ['acknowledgeDiagnosticEvents', 'readDiagnosticEvents'],
  UploadInfo: ['alreadyUploaded', 'complete', 'dispose', 'recoveryScope', 'signal'],
  UploadTask: ['complete', 'fileSizeBytes', 'nextAttemptAt', 'recordingUuid', 'recoveryScope', 'relayUpload'],
};
const NATIVE_OWNED_EXPORTS = [
  'EncryptedUploadProfileSelectionError', 'EncryptedUploadProfileSelectionErrorCode',
  'EncryptedUploadV2CapabilitySnapshot', 'EncryptedUploadV2Checkpoint',
  'EncryptedUploadV2CiphertextSink', 'EncryptedUploadV2ContextProvider',
  'EncryptedUploadV2File', 'EncryptedUploadV2FileSink', 'EncryptedUploadV2Material',
  'EncryptedUploadV2Provider', 'EncryptedUploadV2ProviderContext', 'EncryptedUploadV2Recording',
  'EncryptedUploadV2RuntimeError', 'EncryptedUploadV2RuntimeErrorCode',
  'EncryptedUploadV2SyncOptions', 'EncryptedUploadV2TransferEvidence',
  'PersistedEncryptedUploadV2Checkpoint', 'UploadSecurityPolicy',
];

function maintenanceToolchain(sdkPath) {
  return {
    nodeMajor: Number(process.versions.node.split('.')[0]),
    typescript: ts.version,
    sourceLockDigest: createHash('sha256')
      .update(readFileSync(resolve(sdkPath, 'package-lock.json'))).digest('hex'),
  };
}

export function buildMaintenanceApiContract(options) {
  if (!/^[a-f0-9]{40}$/.test(options.expectedCommit ?? '')) {
    throw new Error('maintenance capture requires a full immutable --expected-commit');
  }
  const source = buildReactNativeApiContract({ ...options, allowDirty: false });
  const toolchain = maintenanceToolchain(options.sdkPath);
  if (toolchain.nodeMajor !== 22 || toolchain.typescript !== '6.0.3') {
    throw new Error('maintenance capture requires Node 22 and locked TypeScript 6.0.3');
  }
  const frozen = validateReactNativeApiContract(JSON.parse(readFileSync(options.frozenContract, 'utf8')));
  const byName = new Map(source.surface.exports.map((entry) => [entry.name, entry]));
  const requireExport = (name) => {
    if (!byName.has(name)) throw new Error(`missing maintenance export ${name}`);
    return byName.get(name);
  };
  const classified = new Set([
    ...frozen.surface.exports.map((entry) => entry.name),
    ...MAINTENANCE_EXPORTS, ...NATIVE_OWNED_EXPORTS,
  ]);
  for (const entry of source.surface.exports) {
    if (!classified.has(entry.name)) throw new Error(`unclassified maintenance export ${entry.name}`);
  }
  return {
    schemaVersion: 1,
    package: source.package,
    packageVersion: source.packageVersion,
    sourceRevision: source.sourceRevision,
    surfaceDigest: source.surfaceDigest,
    sourceExportCount: source.surface.exports.length,
    frozenSurfaceDigest: frozen.surfaceDigest,
    toolchain,
    runtimeTestFiles: [
      '__tests__/encryptedUploadV2ProtocolHandler.test.ts',
      '__tests__/uploadRecovery.test.ts',
      'src/ble/__tests__/deviceDiagnostics.test.ts',
    ],
    additions: {
      exports: MAINTENANCE_EXPORTS.map(requireExport).sort((a, b) => a.name.localeCompare(b.name)),
      members: Object.fromEntries(Object.entries(MAINTENANCE_MEMBERS).map(([name, members]) => [
        name, members.map((memberName) => {
          const member = requireExport(name).members.find((entry) => entry.name === memberName);
          if (!member) throw new Error(`missing maintenance member ${name}.${memberName}`);
          return member;
        }),
      ])),
      // Preserve the frozen no-argument signature with an explicit overload.
      constructSignatures: { RecordingManager: ['(options: RecordingManagerOptions) => RecordingManager'] },
    },
    excludedExports: NATIVE_OWNED_EXPORTS.map((name) => ({
      name: requireExport(name).name,
      reason: 'Native-owned v2 material boundary; no identical JavaScript API or byte ownership claim.',
    })),
    sourceDifferencesFromFrozen: apiDifference(frozen.surface, source.surface),
    limitations: [
      'RecordingDataStore is a source-compatible type only; target configuration rejects JavaScript byte storage.',
      'ProvisioningResult reset_pending/resetFinalized and v2 RecordingManager methods are outside this additions contract.',
      'Maintenance inherited Error declaration differences do not relax the frozen target Error surface.',
      'Additional target-native exports are outside this parity contract; old exported members remain exact.',
      '33 deterministic workflow scenarios are not exhaustive runtime or physical-device parity.',
    ],
  };
}

export function verifyMaintenanceApiContract({ sdkPath, contract, compatibility, frozenContract, expectedRevision }) {
  const expected = typeof contract === 'string'
    ? JSON.parse(readFileSync(contract, 'utf8')) : contract;
  const errors = validateMaintenanceSelection({ contract: expected, compatibility, expectedRevision });
  if (errors.length) throw new Error(errors.join('\n'));
  const actual = buildMaintenanceApiContract({ sdkPath, frozenContract,
    expectedCommit: expected.sourceRevision, expectedVersion: expected.packageVersion });
  errors.push(...validateMaintenanceSource({ contract: expected, source: actual, toolchain: actual.toolchain }));
  if (!isDeepStrictEqual(actual, expected)) errors.push('maintenance additions or source inventory differs; review and recapture');
  if (errors.length) throw new Error(errors.join('\n'));
  return { sourceRevision: actual.sourceRevision, sourceExportCount: actual.sourceExportCount,
    maintenanceExports: actual.additions.exports.length, frozenSurfaceDigest: actual.frozenSurfaceDigest };
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

function requireStringArray(values, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(values)) {
    throw new Error(`invalid React Native API contract ${field}`);
  }
  if (nonEmpty && values.length === 0) {
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
  requireStringArray(member.declarationKinds, `${field} declarationKinds`, {
    nonEmpty: true,
  });
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
      `${exported.name} declarationKinds`,
      { nonEmpty: true }
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
    if (exported.runtime && !('valueType' in exported)) {
      throw new Error(`invalid React Native API contract ${exported.name} valueType`);
    }
    if (!exported.runtime && !('declaredType' in exported)) {
      throw new Error(`invalid React Native API contract ${exported.name} declaredType`);
    }
    if (!exported.runtime && 'valueType' in exported) {
      throw new Error(`invalid React Native API contract ${exported.name} valueType`);
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
  root = process.cwd(),
}) {
  const validContract = validateReactNativeApiContract(contract);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('invalid React Native baseline metadata');
  }
  if (metadata.package !== validContract.package) {
    throw new Error('React Native baseline metadata package does not match contract');
  }
  if (metadata.packageVersion !== validContract.packageVersion) {
    throw new Error('React Native baseline metadata packageVersion does not match contract');
  }
  if (metadata.sourceRevision !== validContract.sourceRevision) {
    throw new Error('React Native baseline metadata sourceRevision does not match contract');
  }
  const canonicalRoot = realpathSync(resolve(root));
  const normalizeContractPath = (path) =>
    relative(canonicalRoot, realpathSync(resolve(canonicalRoot, path)))
      .split(sep)
      .join('/');
  if (
    typeof metadata.publicApi?.contract !== 'string' ||
    normalizeContractPath(metadata.publicApi.contract) !==
      normalizeContractPath(contractPath)
  ) {
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
      case '--frozen-contract':
        options.frozenContract = args[++index];
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
    case 'capture-maintenance': {
      requireOptions(options, ['sdkPath', 'expectedCommit', 'expectedVersion', 'output', 'frozenContract']);
      const contract = buildMaintenanceApiContract(options);
      writeFileSync(resolve(options.output), `${JSON.stringify(contract, null, 2)}\n`);
      console.log(`captured maintenance ${contract.sourceRevision}: ${contract.additions.exports.length} scoped additions / ${contract.sourceExportCount} source exports`);
      return;
    }
    case 'verify-maintenance': {
      requireOptions(options, ['sdkPath', 'contract', 'baselineMetadata', 'frozenContract']);
      console.log(JSON.stringify(verifyMaintenanceApiContract({ ...options,
        expectedRevision: options.expectedCommit,
        compatibility: JSON.parse(readFileSync(options.baselineMetadata, 'utf8')),
      }), null, 2));
      return;
    }
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
      const baselineMetadataPath = resolve(options.baselineMetadata);
      const contract = validateReactNativeApiBaseline({
        contract: JSON.parse(readFileSync(resolve(options.contract), 'utf8')),
        metadata: JSON.parse(
          readFileSync(baselineMetadataPath, 'utf8')
        ),
        contractPath: options.contract,
        root: commandOutput(
          'git',
          ['rev-parse', '--show-toplevel'],
          dirname(baselineMetadataPath)
        ),
      });
      console.log(
        `validated ${contract.package} ${contract.packageVersion}: ${contract.surface.exports.length} exports (${contract.surfaceDigest})`
      );
      return;
    }
    default:
      throw new Error(
        'usage: react-native-api-contract <capture|verify|validate|capture-maintenance|verify-maintenance> [options]'
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
