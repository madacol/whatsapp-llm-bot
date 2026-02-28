import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

const VALID_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/** @type {Array<{fileName: string, action: Action}>} */
let actions = [];

before(async () => {
  const actionsDir = path.resolve(process.cwd(), "actions");
  const files = (await fs.readdir(actionsDir, { recursive: true })).filter((f) => f.endsWith(".js") && !path.basename(f).startsWith("_"));
  for (const file of files) {
    const mod = await import(`file://${path.join(actionsDir, file)}`);
    actions.push({ fileName: file, action: mod.default });
  }
});

describe("all actions conform to Action schema", () => {
  it("found at least one action", () => {
    assert.ok(actions.length > 0, "no action files found");
  });

  it("every action has a snake_case name", () => {
    for (const { fileName, action } of actions) {
      assert.match(
        action.name,
        /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
        `${fileName}: name "${action.name}" must be snake_case`,
      );
    }
  });

  it("every action has a non-empty description", () => {
    for (const { fileName, action } of actions) {
      assert.ok(action.description.trim().length > 0, `${fileName}: description must not be empty`);
    }
  });

  it("every action has valid parameter property schemas", () => {
    for (const { fileName, action } of actions) {
      const params = action.parameters;

      for (const [propName, propSchema] of Object.entries(params.properties)) {
        assert.ok(
          VALID_JSON_SCHEMA_TYPES.has(propSchema.type),
          `${fileName}: property "${propName}" has invalid type "${propSchema.type}"`,
        );
        assert.equal(
          typeof propSchema.description,
          "string",
          `${fileName}: property "${propName}" must have a string description`,
        );
      }

      if (params.required !== undefined) {
        for (const req of params.required) {
          assert.ok(
            req in params.properties,
            `${fileName}: required param "${req}" not found in properties`,
          );
        }
      }
    }
  });

  it("command (if present) is non-empty", () => {
    for (const { fileName, action } of actions) {
      if (action.command !== undefined) {
        assert.ok(action.command.length > 0, `${fileName}: command must not be empty`);
      }
    }
  });

  it("action names are unique", () => {
    const names = actions.map((a) => a.action.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `duplicate action names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it("every action has at least one test_function", () => {
    for (const { fileName, action } of actions) {
      assert.ok(
        action.test_functions.length > 0,
        `${fileName}: test_functions must have at least one test`,
      );
    }
  });

  it("commands are unique", () => {
    const commands = actions
      .map((a) => a.action.command)
      .filter((c) => c !== undefined);
    const unique = new Set(commands);
    assert.equal(commands.length, unique.size, `duplicate commands: ${commands.filter((c, i) => commands.indexOf(c) !== i)}`);
  });
});
