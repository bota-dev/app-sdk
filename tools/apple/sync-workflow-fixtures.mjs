#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "protocol/workflows");
const destination = path.join(
  root,
  "platforms/apple/Tests/BotaAppleSDKTests/Resources/WorkflowFixtures/workflows.json",
);
const check = process.argv.includes("--check");
const names = (await readdir(source))
  .filter((name) => name.endsWith(".json") && name !== "schema.json")
  .sort();

const scenarios = [];
for (const name of names) {
  const suite = JSON.parse(await readFile(path.join(source, name), "utf8"));
  for (const scenario of suite.scenarios) {
    scenarios.push({
      workflow: suite.workflow,
      name: scenario.name,
      classification: scenario.classification,
      command: scenario.command,
      capabilities: scenario.capabilities,
      inputs: scenario.inputs,
      effects: scenario.expected.effects,
      notifications: scenario.expected.notifications,
      terminalStatus: scenario.expected.terminalStatus,
      ...(scenario.expected.errorCode ? { errorCode: scenario.expected.errorCode } : {}),
    });
  }
}

const generated = `${JSON.stringify({ schemaVersion: 1, scenarios }, null, 2)}\n`;
if (check) {
  const actual = await readFile(destination, "utf8");
  if (actual !== generated) {
    throw new Error("Apple workflow fixture resource is stale");
  }
  console.log(`Apple workflow fixtures are current (${scenarios.length} scenarios)`);
} else {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, generated);
  console.log(`Synced ${scenarios.length} Apple workflow scenarios`);
}
