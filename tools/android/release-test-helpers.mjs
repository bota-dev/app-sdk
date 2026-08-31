import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const coordinate = 'dev.bota:bota-android-sdk';
export const version = '1.1.0';

const checksumAlgorithms = ['md5', 'sha1', 'sha256', 'sha512'];

export async function createRawRepository(root, overrides = {}) {
  const artifactDirectory = join(root, 'dev/bota/bota-android-sdk');
  const versionDirectory = join(artifactDirectory, version);
  await mkdir(versionDirectory, { recursive: true });

  const primaries = new Map([
    [`bota-android-sdk-${version}.aar`, Buffer.from('aar-bytes')],
    [`bota-android-sdk-${version}.pom`, Buffer.from(overrides.pom ?? mavenPom())],
    [`bota-android-sdk-${version}.module`, Buffer.from(overrides.module ?? moduleMetadata())],
    [`bota-android-sdk-${version}-sources.jar`, Buffer.from('source-bytes')],
    [`bota-android-sdk-${version}-javadoc.jar`, Buffer.from('javadoc-bytes')],
  ]);

  for (const [name, contents] of primaries) {
    await writeChecksummedFile(versionDirectory, name, contents);
    await writeChecksummedFile(versionDirectory, `${name}.asc`, Buffer.from(`signature:${name}`));
  }

  const metadata = Buffer.from(overrides.metadata ?? mavenMetadata());
  await writeChecksummedFile(artifactDirectory, 'maven-metadata.xml', metadata);
  return { artifactDirectory, versionDirectory, primaries };
}

export async function listFiles(root) {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else result.push(relative);
    }
  }
  await visit(root);
  return result.sort();
}

async function writeChecksummedFile(directory, name, contents) {
  await writeFile(join(directory, name), contents);
  for (const algorithm of checksumAlgorithms) {
    await writeFile(join(directory, `${name}.${algorithm}`), digest(algorithm, contents));
  }
}

function digest(algorithm, contents) {
  return createHash(algorithm).update(contents).digest('hex');
}

export function mavenPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.bota</groupId>
  <artifactId>bota-android-sdk</artifactId>
  <version>${version}</version>
  <name>Bota SDK for Android</name>
  <description>Android facade for connecting applications to Bota devices.</description>
  <url>https://github.com/bota-dev/app-sdk</url>
  <licenses><license><name>MIT License</name><url>https://opensource.org/license/mit</url><distribution>repo</distribution></license></licenses>
  <developers><developer><id>bota-dev</id><name>Bota</name><url>https://bota.dev</url></developer></developers>
  <scm><url>https://github.com/bota-dev/app-sdk</url><connection>scm:git:git://github.com/bota-dev/app-sdk.git</connection><developerConnection>scm:git:ssh://git@github.com/bota-dev/app-sdk.git</developerConnection></scm>
  <dependencies>
    <dependency><groupId>org.jetbrains.kotlinx</groupId><artifactId>kotlinx-coroutines-android</artifactId><version>1.10.2</version><scope>compile</scope></dependency>
    <dependency><groupId>com.squareup.okhttp3</groupId><artifactId>okhttp</artifactId><version>4.12.0</version><scope>compile</scope></dependency>
  </dependencies>
</project>
`;
}

function moduleMetadata() {
  return JSON.stringify({
    formatVersion: '1.1',
    component: { group: 'dev.bota', module: 'bota-android-sdk', version },
    variants: [{
      name: 'release',
      dependencies: [{
        group: 'com.squareup.okhttp3',
        module: 'okhttp',
        version: { requires: '4.12.0' },
      }],
    }],
  });
}

function mavenMetadata() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>dev.bota</groupId>
  <artifactId>bota-android-sdk</artifactId>
  <versioning><latest>${version}</latest><release>${version}</release><versions><version>${version}</version></versions></versioning>
</metadata>
`;
}
