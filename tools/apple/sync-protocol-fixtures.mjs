#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "protocol/fixtures");
const destination = path.join(
  root,
  "platforms/apple/Tests/BotaAppleSDKTests/Resources/ProtocolFixtures",
);
const check = process.argv.includes("--check");
const names = (await readdir(source)).filter((name) => name.endsWith(".json")).sort();

if (check) {
  const destinationNames = (await readdir(destination))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(destinationNames)) {
    throw new Error("Apple protocol fixture resource list is stale");
  }
  for (const name of names) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(source, name)),
      readFile(path.join(destination, name)),
    ]);
    if (!expected.equals(actual)) {
      throw new Error(`Apple protocol fixture resource is stale: ${name}`);
    }
  }
  console.log(`Apple protocol fixtures are current (${names.length} suites)`);
} else {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of names) {
    await writeFile(path.join(destination, name), await readFile(path.join(source, name)));
  }
  console.log(`Synced ${names.length} Apple protocol fixture suites`);
}
