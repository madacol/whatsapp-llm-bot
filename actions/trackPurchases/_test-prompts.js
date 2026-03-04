import assert from "node:assert/strict";

export default [
async function tool_selection_scenarios(callLlm, readFixture) {
      const { actionsToToolDefinitions } = await import("../message-formatting.js");
      const config = (await import("../config.js")).default;
      const fs = await import("fs/promises");
      const path = await import("path");

      // Load all actions for realistic tool list
      const actionsDir = path.resolve(process.cwd(), "actions");
      const files = (await fs.readdir(actionsDir, { recursive: true })).filter(f => f.endsWith(".js") && !path.basename(f).startsWith("_"));
      /** @type {Action[]} */
      const allActions = [];
      for (const file of files) {
        const mod = await import(`file://${path.join(actionsDir, file)}`);
        if (mod.default?.name) allActions.push(mod.default);
      }
      const tools = actionsToToolDefinitions(allActions);

      // Load all fixture images once
      const [receiptBuffer, pizzaBuffer, riverBuffer, fishBuffer, soccerBuffer] = await Promise.all([
        readFixture("receipt-1.jpeg"),
        readFixture("pizza.jpg"),
        readFixture("river.jpg"),
        readFixture("fish plate from south america.jpg"),
        readFixture("Italy soccer fixture league.jpg"),
      ]);

      /** @type {ImageContentBlock} */
      const receiptImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: receiptBuffer.toString("base64") };
      /** @type {ImageContentBlock} */
      const pizzaImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: pizzaBuffer.toString("base64") };
      /** @type {ImageContentBlock} */
      const riverImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: riverBuffer.toString("base64") };
      /** @type {ImageContentBlock} */
      const fishImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: fishBuffer.toString("base64") };
      /** @type {ImageContentBlock} */
      const soccerImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: soccerBuffer.toString("base64") };

      /** @type {Array<{name: string, messages: CallLlmMessage[]}>} */
      const scenarios = [
        {
          name: "clean_conversation",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "user", content: [receiptImage] },
          ],
        },
        {
          name: "after_casual_chat",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "user", content: "que tal el tiempo hoy?" },
            { role: "assistant", content: "Hoy hace buen tiempo, soleado y unos 22 grados." },
            { role: "user", content: [pizzaImage, { type: "text", text: "mira la pizza que hice!" }] },
            { role: "assistant", content: "Que buena pinta! Se ve deliciosa." },
            { role: "user", content: [receiptImage] },
          ],
        },
        {
          name: "after_code_discussion",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "user", content: "como hago un fetch en javascript?" },
            { role: "assistant", content: "Puedes usar `fetch('url').then(r => r.json())` o con async/await." },
            { role: "user", content: [riverImage, { type: "text", text: "mira esta foto de mis vacaciones" }] },
            { role: "assistant", content: "Que bonito paisaje! Donde fue?" },
            { role: "user", content: [receiptImage] },
          ],
        },
        {
          name: "with_brief_text",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "user", content: [receiptImage, { type: "text", text: "mira esto" }] },
          ],
        },
        {
          name: "after_previous_extraction",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "assistant", content: null, tool_calls: [{ id: "call_prev", type: "function", function: { name: "extract_from_image", arguments: '{"prompt":"extract invoice"}' } }] },
            { role: "tool", content: '{"store_name":"Mercadona","items":[...],"total":25.30}', tool_call_id: "call_prev" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_reg", type: "function", function: { name: "track_purchases", arguments: '{"action":"register","store_name":"Mercadona","items":"[...]","total":25.30}' } }] },
            { role: "tool", content: "Factura registrada (ID: 1) — Libro: General\nTienda: Mercadona\nTotal: €25.30", tool_call_id: "call_reg" },
            { role: "assistant", content: "He registrado tu factura de Mercadona por €25.30." },
            { role: "user", content: "gracias!" },
            { role: "assistant", content: "De nada!" },
            { role: "user", content: [receiptImage] },
          ],
        },
        {
          name: "after_unrelated_images",
          messages: [
            { role: "system", content: config.system_prompt },
            { role: "user", content: [fishImage, { type: "text", text: "probé este plato en Colombia" }] },
            { role: "assistant", content: "Se ve increíble! La comida sudamericana es muy rica." },
            { role: "user", content: [soccerImage, { type: "text", text: "viste el partido de ayer?" }] },
            { role: "assistant", content: "No lo vi, pero parece que fue un buen partido!" },
            { role: "user", content: [receiptImage] },
          ],
        },
      ];

      const results = await Promise.all(
        scenarios.map(async (scenario) => {
          try {
            const response = await callLlm({ messages: scenario.messages, tools, tool_choice: "auto" });
            const toolCalls = response.toolCalls;
            if (!toolCalls || toolCalls.length === 0) {
              return { name: scenario.name, error: "LLM should produce tool_calls for a receipt image" };
            }
            const call = toolCalls.find(tc => tc.name === "extract_from_image");
            if (!call) {
              return { name: scenario.name, error: `Expected extract_from_image call, got: ${toolCalls.map(tc => tc.name).join(", ")}` };
            }
            console.log(`  ✔ ${scenario.name}`);
            return { name: scenario.name, error: null };
          } catch (/** @type {unknown} */ err) {
            console.log(`  ✖ ${scenario.name}: ${err instanceof Error ? err.message : String(err)}`);
            return { name: scenario.name, error: err instanceof Error ? err.message : String(err) };
          }
        })
      );

      const failures = results.filter(r => r.error);
      if (failures.length > 0) {
        const details = failures.map(f => `  ${f.name}: ${f.error}`).join("\n");
        assert.fail(`${failures.length}/${results.length} tool selection scenarios failed:\n${details}`);
      }
    },
    async function e2e_partial_items_with_proportional_discounts(callLlm, readFixture) {
      const { actionsToToolDefinitions } = await import("../message-formatting.js");
      const { EXTRACT_PROMPT, parseExtractResponse } = await import(".././tools/extractFromImage.js");
      const { resolveModel } = await import("../model-roles.js");
      const config = (await import("../config.js")).default;
      const fs = await import("fs/promises");
      const path = await import("path");

      // Load all actions for tool list
      const actionsDir = path.resolve(process.cwd(), "actions");
      const files = (await fs.readdir(actionsDir, { recursive: true })).filter(f => f.endsWith(".js") && !path.basename(f).startsWith("_"));
      /** @type {Action[]} */
      const allActions = [];
      for (const file of files) {
        const mod = await import(`file://${path.join(actionsDir, file)}`);
        if (mod.default?.name) allActions.push(mod.default);
      }
      const tools = actionsToToolDefinitions(allActions);

      // Step 1: Extract data from receipt image
      const imageBuffer = await readFixture("receipt-dunnes-discounts.jpeg");
      const base64 = imageBuffer.toString("base64");
      /** @type {ImageContentBlock} */
      const receiptImage = { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 };

      const extractResponse = await callLlm(
        [receiptImage, { type: "text", text: EXTRACT_PROMPT }],
        { model: resolveModel("image_to_text") },
      );
      assert.ok(extractResponse, "extract should return a response");
      const extracted = parseExtractResponse(/** @type {string} */ (extractResponse));
      console.log(`  Extracted: ${extracted.items.length} items, ${extracted.discounts.length} discounts, subtotal=${extracted.subtotal}, total=${extracted.total}`);

      // Step 2: LLM marks items as included/excluded and passes ALL data to track_purchases
      const userPrompt = "solo agrega los huevos, rice cakes, iceberg lettuce, pineapple y lemsip, y calcula bien los descuentos aplicados q le correspondan para ese subtotal";
      /** @type {CallLlmMessage[]} */
      const messages = [
        { role: "system", content: config.system_prompt },
        { role: "user", content: [receiptImage, { type: "text", text: userPrompt }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_extract",
            type: "function",
            function: { name: "extract_from_image", arguments: JSON.stringify({ prompt: EXTRACT_PROMPT }) },
          }],
        },
        {
          role: "tool",
          content: JSON.stringify(extracted),
          tool_call_id: "call_extract",
        },
      ];

      const response = await callLlm(
        // @ts-expect-error -- messages-style call
        { messages, tools, tool_choice: "auto" },
      );
      const toolCalls = response.toolCalls;
      assert.ok(toolCalls && toolCalls.length > 0, "LLM should call track_purchases");

      const registerCall = toolCalls.find((/** @type {{name: string}} */ tc) => tc.name === "track_purchases");
      assert.ok(registerCall, `Expected track_purchases call, got: ${toolCalls.map((/** @type {{name: string}} */ tc) => tc.name).join(", ")}`);

      const args = JSON.parse(registerCall.arguments);
      assert.equal(args.action, "register");

      // Validate: LLM should pass ALL receipt items with included flags
      const allItems = JSON.parse(args.items);
      assert.ok(allItems.length >= 15, `Should pass most/all receipt items (~21), got ${allItems.length}`);

      // Included items should contain the 5 requested keywords
      const includedItems = allItems.filter((/** @type {{included?: boolean}} */ i) => i.included !== false);
      const excludedItems = allItems.filter((/** @type {{included?: boolean}} */ i) => i.included === false);

      const includedNames = includedItems.map((/** @type {{item_name: string}} */ i) => i.item_name.toLowerCase()).join(" | ");
      for (const keyword of ["egg", "rice", "lettuce", "pineapple", "lemsip"]) {
        assert.ok(includedNames.includes(keyword), `Should include '${keyword}' in included items, got: ${includedNames}`);
      }
      assert.ok(excludedItems.length > 0, "Should have excluded items");

      const includedSum = includedItems.reduce((/** @type {number} */ sum, /** @type {{subtotal: number}} */ i) => sum + i.subtotal, 0);
      const allItemsSum = allItems.reduce((/** @type {number} */ sum, /** @type {{subtotal: number}} */ i) => sum + i.subtotal, 0);

      // Validate: LLM should pass ALL discounts from receipt
      assert.ok(args.discounts, "Should include discounts");
      const passedDiscounts = JSON.parse(args.discounts);
      assert.ok(passedDiscounts.length >= 2, `Should pass all receipt discounts, got ${passedDiscounts.length}`);

      const discountsSum = passedDiscounts.reduce((/** @type {number} */ sum, /** @type {{amount: number}} */ d) => sum + d.amount, 0);

      // Validate: total should be the receipt paid total
      assert.ok(args.total, "Should include total");

      console.log(`  ✔ included=${includedItems.length} excluded=${excludedItems.length} allItems=${allItems.length}`);
      console.log(`    includedSum=${includedSum.toFixed(2)}, allItemsSum=${allItemsSum.toFixed(2)}, discounts=${discountsSum.toFixed(2)}, total=${args.total}`);
    },
];
