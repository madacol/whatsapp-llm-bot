import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

const VALID_JSON_SCHEMA_TYPES = new Set([
  "string", "number", "integer", "boolean", "object", "array", "null",
]);

/** @type {Array<{dirName: string, action: Action}>} */
let actions = [];

before(async () => {
  const actionsDir = path.resolve(process.cwd(), "actions");
  const files = (await fs.readdir(actionsDir, { recursive: true }))
    .filter((f) => f === "index.js" || f.endsWith("/index.js"));
  for (const file of files) {
    const mod = await import(`file://${path.join(actionsDir, file)}`);
    actions.push({ dirName: path.dirname(file), action: mod.default });
  }
});

describe("all actions conform to Action schema", () => {
  it("every action has valid metadata (snake_case name, non-empty description/command)", () => {
    assert.ok(actions.length > 0, "no action files found");
    for (const { dirName, action } of actions) {
      assert.match(action.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${dirName}: name "${action.name}" must be snake_case`);
      assert.ok(action.description.trim().length > 0, `${dirName}: description must not be empty`);
      if (action.command !== undefined) {
        assert.ok(action.command.length > 0, `${dirName}: command must not be empty`);
      }
    }
  });

  it("every action has a _tests.js file with at least one test", async () => {
    const actionsDir = path.resolve(process.cwd(), "actions");
    for (const { dirName } of actions) {
      const testsPath = path.join(actionsDir, dirName, "_tests.js");
      await assert.doesNotReject(
        () => fs.access(testsPath),
        `${dirName}: missing _tests.js file`,
      );
      const mod = await import(`file://${testsPath}`);
      assert.ok(
        Array.isArray(mod.default) && mod.default.length > 0,
        `${dirName}: _tests.js must export a non-empty default array`,
      );
    }
  });

  it("every action has valid parameter property schemas", () => {
    for (const { dirName, action } of actions) {
      const params = action.parameters;
      for (const [propName, propSchema] of Object.entries(params.properties)) {
        assert.ok(VALID_JSON_SCHEMA_TYPES.has(propSchema.type), `${dirName}: property "${propName}" has invalid type "${propSchema.type}"`);
        assert.equal(typeof propSchema.description, "string", `${dirName}: property "${propName}" must have a string description`);
      }
      if (params.required !== undefined) {
        for (const req of params.required) {
          assert.ok(req in params.properties, `${dirName}: required param "${req}" not found in properties`);
        }
      }
    }
  });

  it("action names and commands are unique", () => {
    const names = actions.map((a) => a.action.name);
    assert.equal(names.length, new Set(names).size, `duplicate action names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);

    const commands = actions.map((a) => a.action.command).filter((c) => c !== undefined);
    assert.equal(commands.length, new Set(commands).size, `duplicate commands: ${commands.filter((c, i) => commands.indexOf(c) !== i)}`);
  });
});
