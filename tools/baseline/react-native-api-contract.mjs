import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

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
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost()));
  }

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
