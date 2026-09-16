#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "protocol/vectors/encrypted-upload-v2.json");
const digestSource = path.join(
  root,
  "core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs",
);
const destination = path.join(
  root,
  "platforms/android/sdk/src/androidTest/assets/EncryptedUploadV2Vectors",
);
const check = process.argv.includes("--check");
const jsonName = "encrypted-upload-v2.json";
const digestName = "encrypted-upload-v2.sha256";
const names = [jsonName, digestName];
const bytes = await readFile(source);
const digest = createHash("sha256").update(bytes).digest("hex");
const digestBytes = Buffer.from(`${digest}\n`);
const generatedDigest = await readFile(digestSource, "utf8");

if (!generatedDigest.includes(`"${digest}"`)) {
  throw new Error("Generated Rust encrypted-upload-v2 digest is stale");
}

if (check) {
  const destinationNames = (await readdir(destination)).sort();
  if (JSON.stringify(names) !== JSON.stringify(destinationNames)) {
    throw new Error("Android encrypted-upload-v2 resource list is stale");
  }
  const [actualBytes, actualDigest] = await Promise.all([
    readFile(path.join(destination, jsonName)),
    readFile(path.join(destination, digestName)),
  ]);
  if (!bytes.equals(actualBytes) || !digestBytes.equals(actualDigest)) {
    throw new Error("Android encrypted-upload-v2 resources are stale");
  }
  console.log(`Android encrypted-upload-v2 vectors are current (${digest})`);
} else {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(path.join(destination, jsonName), bytes),
    writeFile(path.join(destination, digestName), digestBytes),
  ]);
  console.log(`Synced Android encrypted-upload-v2 vectors (${digest})`);
}
