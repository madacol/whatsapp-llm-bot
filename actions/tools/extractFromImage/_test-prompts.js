import assert from "node:assert/strict";
import { resolveModel } from "../../../model-roles.js";
import { parseExtractResponse } from "./index.js";

export default [
async function extract_prompt_returns_valid_json(callLlm, _readFixture, prompt) {
      /** @type {ContentBlock[]} */
      const content = [
        {
          type: "text",
          text: `Here is the text content of a receipt:

SUPERMERCADO EL SOL
Fecha: 15/06/2025
---
Leche entera 1L    x2    €1.50    €3.00
Pan integral       x1    €1.20    €1.20
Agua mineral 1.5L  x3    €0.60    €1.80
---
TOTAL: €6.00

` + prompt(),
        },
      ];
      const response = await callLlm(content);
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));
      assert.ok(data.store_name, "should extract store name");
      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 3, `should extract at least 3 items, got ${data.items.length}`);
      assert.equal(typeof data.total, "number", "total should be a number");
      assert.ok(data.total > 0, "total should be > 0");

      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", "quantity should be a number");
      }

      // Discounts: text-only receipt with no discounts
      assert.ok(Array.isArray(data.discounts), "discounts should be an array");
      assert.equal(data.discounts.length, 0, `should have no discounts for this receipt, got ${data.discounts.length}`);
      assert.equal(typeof data.subtotal, "number", "subtotal should be a number");
    },
    async function extract_from_receipt_image(callLlm, readFixture, prompt) {
      const imageBuffer = await readFixture("receipt-1.jpeg");
      const base64 = imageBuffer.toString("base64");

      /** @type {ContentBlock[]} */
      const content = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 },
        { type: "text", text: prompt() },
      ];

      const response = await callLlm(content, { model: resolveModel("image_to_text") });
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));

      assert.ok(data.store_name, "should extract store name");
      assert.match(
        data.store_name.toLowerCase(),
        /dunnes/,
        `store name should contain 'dunnes', got '${data.store_name}'`,
      );

      assert.equal(data.purchase_date, "2026-02-17", `date should be 2026-02-17, got '${data.purchase_date}'`);

      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 13, `should extract at least 13 items, got ${data.items.length}`);
      assert.ok(data.items.length <= 17, `should extract at most 17 items, got ${data.items.length}`);

      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", `quantity should be a number for '${item.item_name}'`);
        assert.equal(typeof item.subtotal, "number", `subtotal should be a number for '${item.item_name}'`);
        assert.ok(item.subtotal > 0, `subtotal should be > 0 for '${item.item_name}'`);
      }

      const allNames = data.items.map(i => i.item_name.toLowerCase()).join(" | ");
      for (const keyword of ["mince", "salmon", "milk", "vinegar", "rice"]) {
        assert.ok(allNames.includes(keyword), `should find '${keyword}' in items, got: ${allNames}`);
      }

      const itemsSum = data.items.reduce((sum, item) => sum + item.subtotal, 0);
      assert.ok(
        Math.abs(itemsSum - 51.53) < 2.0,
        `items should sum to ~51.53, got ${itemsSum.toFixed(2)}`,
      );

      assert.equal(data.total, 31.22, `total should be 31.22, got ${data.total}`);

      // Discount extraction
      assert.ok(Array.isArray(data.discounts), "discounts should be an array");
      assert.ok(data.discounts.length > 0, "receipt-1 has discounts, should extract them");
      for (const d of data.discounts) {
        assert.ok(d.description, "each discount should have a description");
        assert.equal(typeof d.amount, "number", `discount amount should be a number for '${d.description}'`);
        assert.ok(d.amount > 0, `discount amount should be > 0 for '${d.description}'`);
      }
      const discountsSum = data.discounts.reduce((sum, d) => sum + d.amount, 0);
      assert.ok(discountsSum > 0, `discounts sum should be > 0, got ${discountsSum}`);
      assert.equal(typeof data.subtotal, "number", "subtotal should be a number");
      assert.ok(
        Math.abs(data.subtotal - discountsSum - data.total) < 1.0,
        `subtotal (${data.subtotal}) - discounts (${discountsSum}) should ≈ total (${data.total})`,
      );
    },
    async function extract_from_receipt_with_discounts(callLlm, readFixture, prompt) {
      const imageBuffer = await readFixture("receipt-dunnes-discounts.jpeg");
      const base64 = imageBuffer.toString("base64");

      /** @type {ContentBlock[]} */
      const content = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 },
        { type: "text", text: prompt() },
      ];

      const response = await callLlm(content, { model: resolveModel("image_to_text") });
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));

      assert.ok(data.store_name, "should extract store name");
      assert.match(
        data.store_name.toLowerCase(),
        /dunnes/,
        `store name should contain 'dunnes', got '${data.store_name}'`,
      );

      assert.equal(data.purchase_date, "2026-03-02", `date should be 2026-03-02, got '${data.purchase_date}'`);

      // Items
      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 18, `should extract at least 18 items, got ${data.items.length}`);
      assert.ok(data.items.length <= 24, `should extract at most 24 items, got ${data.items.length}`);

      const allNames = data.items.map(i => i.item_name.toLowerCase()).join(" | ");
      for (const keyword of ["egg", "rice cake", "lettuce", "pineapple", "lemsip"]) {
        assert.ok(allNames.includes(keyword), `should find '${keyword}' in items, got: ${allNames}`);
      }

      // Subtotal (BAL) should be ~129.21
      assert.ok(
        Math.abs(data.subtotal - 129.21) < 1.0,
        `subtotal should be ~129.21, got ${data.subtotal}`,
      );

      // Discounts: employee (25.84) + vouchers (10 + 10 + 5 = 25) = 50.84
      assert.ok(Array.isArray(data.discounts), "discounts should be an array");
      assert.ok(data.discounts.length >= 2, `should have at least 2 discount types, got ${data.discounts.length}`);
      const discountsSum = data.discounts.reduce((sum, d) => sum + d.amount, 0);
      assert.ok(
        Math.abs(discountsSum - 50.84) < 1.0,
        `discounts should sum to ~50.84, got ${discountsSum.toFixed(2)}`,
      );

      // Total (BAL TO PAY) should be 78.37
      assert.ok(
        Math.abs(data.total - 78.37) < 1.0,
        `total should be ~78.37, got ${data.total}`,
      );

      // Validate consistency: subtotal - discounts ≈ total
      assert.ok(
        Math.abs(data.subtotal - discountsSum - data.total) < 1.0,
        `subtotal (${data.subtotal}) - discounts (${discountsSum.toFixed(2)}) should ≈ total (${data.total})`,
      );
    },
];
