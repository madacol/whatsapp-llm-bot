import assert from "node:assert/strict";

const EXTRACT_PROMPT = `Analiza esta imagen de una factura/recibo de compra. Extrae la siguiente informacion en formato JSON estricto (sin markdown, solo JSON puro):
{
  "store_name": "nombre de la tienda/comercio",
  "purchase_date": "fecha de compra (formato YYYY-MM-DD, o null si no se ve)",
  "items": [
    {
      "item_name": "nombre del producto",
      "quantity": 1,
      "unit_price": 0.00,
      "subtotal": 0.00
    }
  ],
  "total": 0.00
}

IMPORTANTE:
- Los precios deben ser numeros sin simbolos de moneda
- Si no puedes leer algun campo, pon null
- Extrae TODOS los items visibles
- El total debe ser el monto total de la factura (lo que realmente se pago, despues de descuentos)
- Responde SOLO con el JSON, nada mas`;

/**
 * @param {string} raw - Raw LLM response (may contain markdown fences)
 * @returns {{ store_name: string|null, purchase_date: string|null, items: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, total: number }}
 */
function parseExtractResponse(raw) {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

/**
 * Ensure the purchases schema exists.
 * @param {PGlite} db
 */
async function ensureSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      store_name TEXT,
      purchase_date TEXT,
      total NUMERIC(12,2),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await db.sql`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
      item_name TEXT,
      quantity NUMERIC(10,2) DEFAULT 1,
      unit_price NUMERIC(12,2),
      subtotal NUMERIC(12,2)
    )
  `;
}

export { EXTRACT_PROMPT, parseExtractResponse, ensureSchema };

export default /** @type {defineAction} */ ((x) => x)({
  name: "track_purchases",
  command: "compras",
  description: "Gestiona un registro de compras. Puede: 1) Extraer items de una foto de factura y guardarlos, 2) Mostrar el historial de compras, 3) Mostrar un resumen/total de gastos. Envía una foto de factura para registrarla o pide ver el historial.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Acción a realizar: 'extract' para extraer de foto, 'history' para ver historial, 'summary' para resumen de gastos, 'delete' para borrar un registro por ID",
        enum: ["extract", "history", "summary", "delete"]
      },
      purchase_id: {
        type: "string",
        description: "ID de la compra a eliminar (solo para action=delete)"
      }
    },
    required: ["action"]
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useChatDb: true,
    useLlm: true
  },
  test_functions: [
    async function history_empty(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "history" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No tienes compras"));
    },
    async function history_with_data(action_fn, db) {
      await ensureSchema(db);
      await db.sql`INSERT INTO purchases (store_name, purchase_date, total) VALUES ('TestStore', '2025-01-15', 42.50)`;
      const { rows: [purchase] } = await db.sql`SELECT id FROM purchases WHERE store_name = 'TestStore'`;
      await db.sql`INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal) VALUES (${purchase.id}, 'Leche', 2, 1.50, 3.00)`;
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "history" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("TestStore"));
      assert.ok(result.includes("Leche"));
      assert.ok(result.includes("42.50"));
    },
    async function summary_empty(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "summary" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Total compras"));
    },
    async function delete_nonexistent(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "delete", purchase_id: "9999" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No se encontro"));
    },
    async function delete_existing(action_fn, db) {
      await ensureSchema(db);
      await db.sql`INSERT INTO purchases (store_name, total) VALUES ('ToDelete', 10.00)`;
      const { rows: [purchase] } = await db.sql`SELECT id FROM purchases WHERE store_name = 'ToDelete'`;
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "delete", purchase_id: String(purchase.id) },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("eliminada"));
      const { rows } = await db.sql`SELECT * FROM purchases WHERE id = ${purchase.id}`;
      assert.equal(rows.length, 0);
    },
    async function extract_no_image(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { chatDb: db, callLlm: async () => null, content: [], log: async () => "" },
        { action: "extract" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No encontre ninguna foto"));
    },
    async function extract_with_mock_llm(action_fn, db) {
      await ensureSchema(db);
      const mockResponse = JSON.stringify({
        store_name: "Supermercado Test",
        purchase_date: "2025-06-15",
        items: [
          { item_name: "Pan", quantity: 1, unit_price: 1.20, subtotal: 1.20 },
          { item_name: "Agua", quantity: 2, unit_price: 0.50, subtotal: 1.00 },
        ],
        total: 2.20,
      });
      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];
      const result = await action_fn(
        { chatDb: db, callLlm: async () => mockResponse, content: contentWithImage, log: async () => "" },
        { action: "extract" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Supermercado Test"));
      assert.ok(result.includes("Pan"));
      assert.ok(result.includes("2.20"));

      // Verify data was inserted
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'Supermercado Test'`;
      assert.equal(purchases.length, 1);
      const { rows: items } = await db.sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchases[0].id} ORDER BY item_name`;
      assert.equal(items.length, 2);
    },
    async function parse_extract_response_strips_markdown(_action_fn, _db) {
      const raw = '```json\n{"store_name": "Test", "items": [], "total": 0}\n```';
      const data = parseExtractResponse(raw);
      assert.equal(data.store_name, "Test");
      assert.deepEqual(data.items, []);
    },
  ],
  test_prompts: [
    async function extract_prompt_returns_valid_json(callLlm, _readFixture) {
      // Send a text description of a receipt to test the extraction prompt
      // (tests the prompt quality without requiring an actual image fixture)
      /** @type {ContentBlock[]} */
      const prompt = [
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

` + EXTRACT_PROMPT,
        },
      ];
      const response = await callLlm(prompt);
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));
      assert.ok(data.store_name, "should extract store name");
      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 3, `should extract at least 3 items, got ${data.items.length}`);
      assert.equal(typeof data.total, "number", "total should be a number");
      assert.ok(data.total > 0, "total should be > 0");

      // Verify each item has the required fields
      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", "quantity should be a number");
      }
    },
    async function extract_from_receipt_image(callLlm, readFixture) {
      const imageBuffer = await readFixture("receipt-1.jpeg");
      const base64 = imageBuffer.toString("base64");

      /** @type {ContentBlock[]} */
      const prompt = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 },
        { type: "text", text: EXTRACT_PROMPT },
      ];

      const response = await callLlm(prompt);
      assert.ok(response, "LLM should return a response");

      const data = parseExtractResponse(/** @type {string} */ (response));

      // Store identification
      assert.ok(data.store_name, "should extract store name");
      assert.match(
        data.store_name.toLowerCase(),
        /dunnes/,
        `store name should contain 'dunnes', got '${data.store_name}'`,
      );

      // Date
      assert.ok(data.purchase_date, "should extract date");

      // Items — receipt has ~15 items (mince, salmon, juice, milk, vinegar, rice cakes, etc.)
      assert.ok(Array.isArray(data.items), "items should be an array");
      assert.ok(data.items.length >= 10, `should extract at least 10 items, got ${data.items.length}`);

      // Total — receipt shows BAL TO PAY €31.22
      assert.equal(typeof data.total, "number", "total should be a number");
      assert.ok(data.total > 25 && data.total < 55, `total should be between 25-55, got ${data.total}`);

      for (const item of data.items) {
        assert.ok(item.item_name, "each item should have a name");
        assert.equal(typeof item.quantity, "number", "quantity should be a number");
      }
    },
  ],
  action_fn: async function (context, params) {
    const { chatDb, callLlm, content, log } = context;

    await ensureSchema(chatDb);

    if (params.action === "extract") {
      /** @type {ImageContentBlock | undefined} */
      const image = /** @type {ImageContentBlock | undefined} */ (content.find(c => c.type === "image"));
      if (!image) {
        return "No encontre ninguna foto de factura. Por favor envia una imagen de la factura junto con el comando.";
      }

      await log("Analizando factura...");

      /** @type {ContentBlock[]} */
      const prompt = [
        image,
        { type: "text", text: EXTRACT_PROMPT },
      ];

      const llmResponse = await callLlm(prompt);
      if (!llmResponse) {
        return "No pude analizar la factura. Intenta con una foto mas clara.";
      }

      let data;
      try {
        data = parseExtractResponse(llmResponse);
      } catch {
        return "No pude interpretar los datos de la factura. Intenta con una foto mas clara.";
      }

      const { rows } = await chatDb.sql`
        INSERT INTO purchases (store_name, purchase_date, total, notes)
        VALUES (${data.store_name || "Desconocido"}, ${data.purchase_date}, ${data.total || 0}, ${""})
        RETURNING id
      `;
      const purchaseId = rows[0].id;

      if (data.items && data.items.length > 0) {
        for (const item of data.items) {
          await chatDb.sql`
            INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal)
            VALUES (${purchaseId}, ${item.item_name}, ${item.quantity || 1}, ${item.unit_price || 0}, ${item.subtotal || 0})
          `;
        }
      }

      let result = `*Factura registrada* (ID: ${purchaseId})\n\n`;
      result += `*Tienda:* ${data.store_name || "No identificada"}\n`;
      result += `*Fecha:* ${data.purchase_date || "No identificada"}\n\n`;
      result += `*Items:*\n`;

      if (data.items && data.items.length > 0) {
        for (const [i, item] of data.items.entries()) {
          const price = item.subtotal || item.unit_price || 0;
          result += `  ${i + 1}. ${item.item_name} — x${item.quantity || 1} — €${Number(price).toFixed(2)}\n`;
        }
      }

      result += `\n*Total: €${Number(data.total || 0).toFixed(2)}*`;
      return result;

    } else if (params.action === "history") {
      const { rows: purchases } = await chatDb.sql`
        SELECT * FROM purchases ORDER BY created_at DESC LIMIT 20
      `;

      if (purchases.length === 0) {
        return "No tienes compras registradas aun. Enviame una foto de una factura para empezar.";
      }

      let result = "*Historial de Compras*\n\n";
      for (const p of purchases) {
        const { rows: items } = await chatDb.sql`
          SELECT * FROM purchase_items WHERE purchase_id = ${p.id}
        `;
        result += `*#${p.id}* — ${p.store_name || "?"} — ${p.purchase_date || "Sin fecha"}\n`;
        for (const item of items) {
          result += `  • ${item.item_name} x${item.quantity} — €${Number(item.subtotal).toFixed(2)}\n`;
        }
        result += `  *Total: €${Number(p.total).toFixed(2)}*\n\n`;
      }
      return result;

    } else if (params.action === "summary") {
      const { rows: summary } = await chatDb.sql`
        SELECT 
          COUNT(*) as total_purchases,
          COALESCE(SUM(total), 0) as total_spent
        FROM purchases
      `;
      const { rows: byStore } = await chatDb.sql`
        SELECT 
          store_name,
          COUNT(*) as visits,
          SUM(total) as spent
        FROM purchases
        GROUP BY store_name
        ORDER BY spent DESC
        LIMIT 10
      `;
      const { rows: topItems } = await chatDb.sql`
        SELECT 
          item_name,
          SUM(quantity) as total_qty,
          SUM(subtotal) as total_spent
        FROM purchase_items
        GROUP BY item_name
        ORDER BY total_spent DESC
        LIMIT 10
      `;

      const s = summary[0];
      let result = "*Resumen de Gastos*\n\n";
      result += `*Total compras:* ${s.total_purchases}\n`;
      result += `*Total gastado:* €${Number(s.total_spent).toFixed(2)}\n\n`;

      if (byStore.length > 0) {
        result += `*Por tienda:*\n`;
        for (const store of byStore) {
          result += `  • ${store.store_name || "?"}: ${store.visits} visitas — €${Number(store.spent).toFixed(2)}\n`;
        }
        result += "\n";
      }

      if (topItems.length > 0) {
        result += `*Top productos (por gasto):*\n`;
        for (const [i, item] of topItems.entries()) {
          result += `  ${i + 1}. ${item.item_name} — x${Number(item.total_qty)} — €${Number(item.total_spent).toFixed(2)}\n`;
        }
      }

      return result;

    } else if (params.action === "delete") {
      if (!params.purchase_id) {
        return "Necesito el ID de la compra a eliminar. Usa !compras para ver el historial.";
      }
      const { rows } = await chatDb.sql`
        DELETE FROM purchases WHERE id = ${params.purchase_id} RETURNING id, store_name
      `;
      if (rows.length === 0) {
        return `No se encontro la compra con ID ${params.purchase_id}`;
      }
      return `Compra #${rows[0].id} (${rows[0].store_name}) eliminada correctamente.`;
    }

    return "Accion no reconocida. Usa: extract, history, summary o delete.";
  }
});
