import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

const VALID_PERMISSION_KEYS = new Set([
  "autoExecute",
  "autoContinue",
  "requireAdmin",
  "requireMaster",
  "useChatDb",
  "useRootDb",
  "useFileSystem",
  "useLlm",
]);

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
  const files = (await fs.readdir(actionsDir)).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const mod = await import(`file://${path.join(actionsDir, file)}`);
    actions.push({ fileName: file, action: mod.default });
  }
});

describe("all actions conform to Action schema", () => {
  it("found at least one action", () => {
    assert.ok(actions.length > 0, "no action files found");
  });

  it("every action has a default export", () => {
    for (const { fileName, action } of actions) {
      assert.ok(action, `${fileName} has no default export`);
    }
  });

  it("every action has a snake_case name", () => {
    for (const { fileName, action } of actions) {
      assert.equal(typeof action.name, "string", `${fileName}: name must be a string`);
      assert.ok(action.name.length > 0, `${fileName}: name must not be empty`);
      assert.match(
        action.name,
        /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
        `${fileName}: name "${action.name}" must be snake_case`,
      );
    }
  });

  it("every action has a non-empty description", () => {
    for (const { fileName, action } of actions) {
      assert.equal(typeof action.description, "string", `${fileName}: description must be a string`);
      assert.ok(action.description.trim().length > 0, `${fileName}: description must not be empty`);
    }
  });

  it("every action has a valid parameters JSON Schema", () => {
    for (const { fileName, action } of actions) {
      const params = action.parameters;
      assert.ok(params, `${fileName}: parameters must be defined`);
      assert.equal(params.type, "object", `${fileName}: parameters.type must be "object"`);
      assert.equal(
        typeof params.properties,
        "object",
        `${fileName}: parameters.properties must be an object`,
      );

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
        assert.ok(
          Array.isArray(params.required),
          `${fileName}: parameters.required must be an array`,
        );
        for (const req of params.required) {
          assert.ok(
            req in params.properties,
            `${fileName}: required param "${req}" not found in properties`,
          );
        }
      }
    }
  });

  it("every action has only valid permission keys", () => {
    for (const { fileName, action } of actions) {
      assert.ok(action.permissions, `${fileName}: permissions must be defined`);
      for (const key of Object.keys(action.permissions)) {
        assert.ok(
          VALID_PERMISSION_KEYS.has(key),
          `${fileName}: unknown permission key "${key}"`,
        );
      }
    }
  });

  it("every action has an action_fn that is a function", () => {
    for (const { fileName, action } of actions) {
      assert.equal(
        typeof action.action_fn,
        "function",
        `${fileName}: action_fn must be a function`,
      );
    }
  });

  it("command (if present) is a short non-empty string", () => {
    for (const { fileName, action } of actions) {
      if (action.command !== undefined) {
        assert.equal(typeof action.command, "string", `${fileName}: command must be a string`);
        assert.ok(action.command.length > 0, `${fileName}: command must not be empty`);
      }
    }
  });

  it("action names are unique", () => {
    const names = actions.map((a) => a.action.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `duplicate action names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it("every action has a non-empty test_functions array of functions", () => {
    for (const { fileName, action } of actions) {
      assert.ok(
        Array.isArray(action.test_functions),
        `${fileName}: test_functions must be an array`,
      );
      assert.ok(
        action.test_functions.length > 0,
        `${fileName}: test_functions must have at least one test`,
      );
      for (const fn of action.test_functions) {
        assert.equal(
          typeof fn,
          "function",
          `${fileName}: every test_functions entry must be a function`,
        );
      }
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
