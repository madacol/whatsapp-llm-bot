#!/usr/bin/env node
import { runAcpAdapterSmoke } from "#harnesses";

const args = process.argv.slice(2);
const prompt = args.includes("--prompt");
const target = args.find((arg) => !arg.startsWith("--")) ?? "all";
const results = await runAcpAdapterSmoke({ target, prompt });
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.ok !== true)) {
  process.exitCode = 1;
}
