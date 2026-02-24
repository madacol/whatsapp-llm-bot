import assert from "node:assert/strict";

const EXTRACT_PROMPT = `Extrae datos de la factura en JSON estricto (solo JSON):
{
  "store_name": "nombre",
  "purchase_date": "YYYY-MM-DD o null",
  "items": [{ "item_name": "nombre", "quantity": 1, "unit_price": 0.0, "subtotal": 0.0 }],
  "total": 0.0
}

Reglas:
- Solo números en precios (sin símbolos).
- Usa null si el dato es ilegible.
- Extrae TODOS los productos individuales.
- Excluye descuentos, cupones o subtotales de la lista de items.
- "total" es el monto final neto pagado.
- Sin texto adicional ni markdown.`;

/**
 * @param {string} raw - Raw LLM response (may contain markdown fences)
 * @returns {{ store_name: string|null, purchase_date: string|null, items: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, total: number }}
 */
function parseExtractResponse(raw) {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

/**
 * Ensure the purchases schema exists (with ledger support).
 * @param {PGlite} db
 */
async function ensureSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS ledgers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await db.sql`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      ledger_id INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,
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

/**
 * Get or create a ledger by name (case-insensitive).
 * @param {PGlite} db
 * @param {string} name
 * @returns {Promise<{id: number, name: string}>}
 */
async function getOrCreateLedger(db, name) {
  const { rows } = await db.sql`
    SELECT id, name FROM ledgers WHERE LOWER(name) = LOWER(${name})
  `;
  if (rows.length > 0) {
    return /** @type {{id: number, name: string}} */ (rows[0]);
  }
  const { rows: inserted } = await db.sql`
    INSERT INTO ledgers (name) VALUES (${name}) RETURNING id, name
  `;
  return /** @type {{id: number, name: string}} */ (inserted[0]);
}

/**
 * Format a receipt preview for confirmation.
 * @param {{ store_name: string|null, purchase_date: string|null, items: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, total: number }} data
 * @param {string} ledgerName
 * @returns {string}
 */
function formatPreview(data, ledgerName) {
  let preview = `*Vista previa de factura*\n`;
  preview += `*Libro:* ${ledgerName}\n`;
  preview += `*Tienda:* ${data.store_name || "No identificada"}\n`;
  preview += `*Fecha:* ${data.purchase_date || "No identificada"}\n\n`;
  preview += `*Items:*\n`;
  if (data.items && data.items.length > 0) {
    for (const [i, item] of data.items.entries()) {
      const price = item.subtotal || item.unit_price || 0;
      preview += `  ${i + 1}. ${item.item_name} — x${item.quantity || 1} — €${Number(price).toFixed(2)}\n`;
    }
  }
  preview += `\n*Total: €${Number(data.total || 0).toFixed(2)}*\n\n`;
  preview += `React 👍 para guardar o 👎 para cancelar.`;
  return preview;
}

/**
 * Get purchase history, optionally filtered by ledger name.
 * @param {PGlite} db
 * @param {string} [ledgerName]
 * @returns {Promise<string>}
 */
async function getHistory(db, ledgerName) {
  /** @type {number | undefined} */
  let ledgerId;
  if (ledgerName) {
    const { rows } = await db.sql`SELECT id FROM ledgers WHERE LOWER(name) = LOWER(${ledgerName})`;
    if (rows.length === 0) return `No se encontro el libro "${ledgerName}".`;
    ledgerId = /** @type {number} */ (rows[0].id);
  }

  const { rows: purchases } = ledgerId !== undefined
    ? await db.sql`
        SELECT p.*, l.name as ledger_name FROM purchases p
        JOIN ledgers l ON p.ledger_id = l.id
        WHERE p.ledger_id = ${ledgerId}
        ORDER BY p.created_at DESC LIMIT 20`
    : await db.sql`
        SELECT p.*, l.name as ledger_name FROM purchases p
        JOIN ledgers l ON p.ledger_id = l.id
        ORDER BY p.created_at DESC LIMIT 20`;

  if (purchases.length === 0) {
    return ledgerName
      ? `No tienes compras en el libro "${ledgerName}".`
      : "No tienes compras registradas aun. Enviame una foto de una factura para empezar.";
  }

  let result = ledgerName
    ? `*Historial de Compras — ${ledgerName}*\n\n`
    : "*Historial de Compras*\n\n";

  for (const p of purchases) {
    const { rows: items } = await db.sql`SELECT * FROM purchase_items WHERE purchase_id = ${p.id}`;
    const prefix = ledgerName ? `*#${p.id}*` : `*#${p.id}* [${p.ledger_name}]`;
    result += `${prefix} — ${p.store_name || "?"} — ${p.purchase_date || "Sin fecha"}\n`;
    for (const item of items) {
      result += `  • ${item.item_name} x${item.quantity} — €${Number(item.subtotal).toFixed(2)}\n`;
    }
    result += `  *Total: €${Number(p.total).toFixed(2)}*\n\n`;
  }
  return result;
}

/**
 * Get purchase summary, optionally filtered by ledger name.
 * @param {PGlite} db
 * @param {string} [ledgerName]
 * @returns {Promise<string>}
 */
async function getSummary(db, ledgerName) {
  /** @type {number | undefined} */
  let ledgerId;
  if (ledgerName) {
    const { rows } = await db.sql`SELECT id, name FROM ledgers WHERE LOWER(name) = LOWER(${ledgerName})`;
    if (rows.length === 0) return `No se encontro el libro "${ledgerName}".`;
    ledgerId = /** @type {number} */ (rows[0].id);
  }

  const { rows: summary } = ledgerId !== undefined
    ? await db.sql`SELECT COUNT(*) as total_purchases, COALESCE(SUM(total), 0) as total_spent FROM purchases WHERE ledger_id = ${ledgerId}`
    : await db.sql`SELECT COUNT(*) as total_purchases, COALESCE(SUM(total), 0) as total_spent FROM purchases`;

  const { rows: byStore } = ledgerId !== undefined
    ? await db.sql`SELECT store_name, COUNT(*) as visits, SUM(total) as spent FROM purchases WHERE ledger_id = ${ledgerId} GROUP BY store_name ORDER BY spent DESC LIMIT 10`
    : await db.sql`SELECT store_name, COUNT(*) as visits, SUM(total) as spent FROM purchases GROUP BY store_name ORDER BY spent DESC LIMIT 10`;

  const { rows: topItems } = ledgerId !== undefined
    ? await db.sql`SELECT pi.item_name, SUM(pi.quantity) as total_qty, SUM(pi.subtotal) as total_spent FROM purchase_items pi JOIN purchases p ON pi.purchase_id = p.id WHERE p.ledger_id = ${ledgerId} GROUP BY pi.item_name ORDER BY total_spent DESC LIMIT 10`
    : await db.sql`SELECT item_name, SUM(quantity) as total_qty, SUM(subtotal) as total_spent FROM purchase_items GROUP BY item_name ORDER BY total_spent DESC LIMIT 10`;

  const s = summary[0];
  let result = ledgerName
    ? `*Resumen de Gastos — ${ledgerName}*\n\n`
    : "*Resumen de Gastos*\n\n";
  result += `*Total compras:* ${s.total_purchases}\n`;
  result += `*Total gastado:* €${Number(s.total_spent).toFixed(2)}\n\n`;

  if (!ledgerName) {
    const { rows: byLedger } = await db.sql`
      SELECT l.name as ledger_name, COUNT(*) as count, SUM(p.total) as spent
      FROM purchases p JOIN ledgers l ON p.ledger_id = l.id
      GROUP BY l.name ORDER BY spent DESC`;
    if (byLedger.length > 0) {
      result += `*Por libro:*\n`;
      for (const l of byLedger) {
        result += `  • ${l.ledger_name}: ${l.count} compras — €${Number(l.spent).toFixed(2)}\n`;
      }
      result += "\n";
    }
  }

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
}

export { EXTRACT_PROMPT, parseExtractResponse, ensureSchema, getOrCreateLedger, formatPreview };

export default /** @type {defineAction} */ ((x) => x)({
  name: "track_purchases",
  command: "compras",
  description: "When the user sends an image that looks like a receipt or invoice, call this with action='extract' to extract and save the purchase data. Also use for: purchase history ('history'), spending summary ('summary'), deleting a purchase ('delete'), and ledger management ('list_ledgers', 'rename_ledger', 'delete_ledger').",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Acción a realizar: 'extract' para extraer de foto, 'history' para ver historial, 'summary' para resumen de gastos, 'delete' para borrar un registro por ID, 'list_ledgers' para listar libros, 'rename_ledger' para renombrar un libro, 'delete_ledger' para eliminar un libro y sus compras",
        enum: ["extract", "history", "summary", "delete", "list_ledgers", "rename_ledger", "delete_ledger"]
      },
      purchase_id: {
        type: "string",
        description: "ID de la compra a eliminar (solo para action=delete)"
      },
      ledger_name: {
        type: "string",
        description: "Nombre del libro de compras. Para 'extract': libro donde guardar (default: 'General'). Para 'history'/'summary': filtrar por libro. Para 'rename_ledger'/'delete_ledger': libro a modificar."
      },
      new_ledger_name: {
        type: "string",
        description: "Nuevo nombre para el libro (solo para action=rename_ledger)"
      }
    },
    required: ["action"]
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useLlm: true
  },
  test_functions: [
    async function history_empty(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "history" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No tienes compras"));
    },
    async function history_with_data(action_fn, db) {
      await ensureSchema(db);
      const ledger = await getOrCreateLedger(db, "General");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, purchase_date, total) VALUES (${ledger.id}, 'TestStore', '2025-01-15', 42.50)`;
      const { rows: [purchase] } = await db.sql`SELECT id FROM purchases WHERE store_name = 'TestStore'`;
      await db.sql`INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal) VALUES (${purchase.id}, 'Leche', 2, 1.50, 3.00)`;
      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "summary" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Total compras"));
    },
    async function delete_nonexistent(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "delete", purchase_id: "9999" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("No se encontro"));
    },
    async function delete_existing(action_fn, db) {
      await ensureSchema(db);
      const ledger = await getOrCreateLedger(db, "General");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${ledger.id}, 'ToDelete', 10.00)`;
      const { rows: [purchase] } = await db.sql`SELECT id FROM purchases WHERE store_name = 'ToDelete'`;
      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: async () => mockResponse, content: contentWithImage, log: async () => "", confirm: async () => true },
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

      // Verify default ledger was created
      const { rows: ledgers } = await db.sql`SELECT * FROM ledgers WHERE LOWER(name) = 'general'`;
      assert.equal(ledgers.length, 1);
      assert.equal(purchases[0].ledger_id, ledgers[0].id);
    },
    async function parse_extract_response_strips_markdown(_action_fn, _db) {
      const raw = '```json\n{"store_name": "Test", "items": [], "total": 0}\n```';
      const data = parseExtractResponse(raw);
      assert.equal(data.store_name, "Test");
      assert.deepEqual(data.items, []);
    },

    // --- New tests for confirmation flow ---
    async function extract_cancelled_by_user(action_fn, db) {
      await ensureSchema(db);
      const mockResponse = JSON.stringify({
        store_name: "CancelStore",
        purchase_date: "2025-06-15",
        items: [{ item_name: "Item1", quantity: 1, unit_price: 5.00, subtotal: 5.00 }],
        total: 5.00,
      });
      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];
      const raw = await action_fn(
        { db, callLlm: async () => mockResponse, content: contentWithImage, log: async () => "", confirm: async () => false },
        { action: "extract" },
      );
      // Should return ActionSignal with autoContinue: false
      assert.equal(typeof raw, "object");
      assert.equal(raw.autoContinue, false, "Should signal autoContinue: false on cancellation");
      assert.ok(raw.result.includes("cancelad"), `Expected cancellation message, got: ${raw.result}`);

      // Verify nothing was inserted
      const { rows } = await db.sql`SELECT * FROM purchases WHERE store_name = 'CancelStore'`;
      assert.equal(rows.length, 0, "No purchases should be saved when cancelled");
    },

    // --- Transaction atomicity ---
    async function extract_rolls_back_on_item_error(action_fn, db) {
      await ensureSchema(db);
      const mockResponse = JSON.stringify({
        store_name: "AtomicStore",
        purchase_date: "2025-06-15",
        items: [
          { item_name: "GoodItem", quantity: 1, unit_price: 5.00, subtotal: 5.00 },
          { item_name: "BadItem", quantity: 1, unit_price: 1.00, subtotal: "not_a_number" },
        ],
        total: 6.00,
      });
      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];
      try {
        await action_fn(
          { db, callLlm: async () => mockResponse, content: contentWithImage, log: async () => "", confirm: async () => true },
          { action: "extract" },
        );
      } catch {
        // Expected to throw due to invalid NUMERIC value
      }

      // The purchase should NOT exist if the transaction rolled back
      const { rows } = await db.sql`SELECT * FROM purchases WHERE store_name = 'AtomicStore'`;
      assert.equal(rows.length, 0, "Purchase should be rolled back when item insert fails");
    },

    // --- Named ledger tests ---
    async function extract_with_named_ledger(action_fn, db) {
      await ensureSchema(db);
      const mockResponse = JSON.stringify({
        store_name: "LedgerStore",
        purchase_date: "2025-07-01",
        items: [{ item_name: "ItemX", quantity: 1, unit_price: 10.00, subtotal: 10.00 }],
        total: 10.00,
      });
      /** @type {ContentBlock[]} */
      const contentWithImage = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "fakebase64" },
      ];
      const result = await action_fn(
        { db, callLlm: async () => mockResponse, content: contentWithImage, log: async () => "", confirm: async () => true },
        { action: "extract", ledger_name: "Groceries" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("LedgerStore"));

      // Verify ledger was created with correct name
      const { rows: ledgers } = await db.sql`SELECT * FROM ledgers WHERE LOWER(name) = 'groceries'`;
      assert.equal(ledgers.length, 1);
      assert.equal(ledgers[0].name, "Groceries");

      // Verify purchase is linked to the ledger
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'LedgerStore'`;
      assert.equal(purchases.length, 1);
      assert.equal(purchases[0].ledger_id, ledgers[0].id);
    },

    // --- list_ledgers ---
    async function list_ledgers_shows_counts(action_fn, db) {
      await ensureSchema(db);
      const l1 = await getOrCreateLedger(db, "Food");
      const l2 = await getOrCreateLedger(db, "Office");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l1.id}, 'Store1', 10.00)`;
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l1.id}, 'Store2', 20.00)`;
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l2.id}, 'Store3', 5.00)`;

      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "list_ledgers" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Food"), `Should include 'Food', got: ${result}`);
      assert.ok(result.includes("Office"), `Should include 'Office', got: ${result}`);
      assert.ok(result.includes("30.00"), `Should show total 30.00 for Food, got: ${result}`);
      assert.ok(result.includes("5.00"), `Should show total 5.00 for Office, got: ${result}`);
    },

    // --- rename_ledger ---
    async function rename_ledger_works(action_fn, db) {
      await ensureSchema(db);
      await getOrCreateLedger(db, "OldName");

      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "rename_ledger", ledger_name: "OldName", new_ledger_name: "NewName" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("NewName"), `Should confirm new name, got: ${result}`);

      const { rows } = await db.sql`SELECT * FROM ledgers WHERE name = 'NewName'`;
      assert.equal(rows.length, 1);
      const { rows: old } = await db.sql`SELECT * FROM ledgers WHERE name = 'OldName'`;
      assert.equal(old.length, 0);
    },

    // --- delete_ledger ---
    async function delete_ledger_cascades(action_fn, db) {
      await ensureSchema(db);
      const ledger = await getOrCreateLedger(db, "ToDeleteLedger");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${ledger.id}, 'CascadeStore', 15.00)`;

      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "delete_ledger", ledger_name: "ToDeleteLedger" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("eliminado") || result.includes("eliminada"), `Should confirm deletion, got: ${result}`);

      // Verify ledger and purchases are gone
      const { rows: ledgers } = await db.sql`SELECT * FROM ledgers WHERE name = 'ToDeleteLedger'`;
      assert.equal(ledgers.length, 0);
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'CascadeStore'`;
      assert.equal(purchases.length, 0);
    },

    async function delete_ledger_cancelled(action_fn, db) {
      await ensureSchema(db);
      await getOrCreateLedger(db, "KeepLedger");

      const raw = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => false },
        { action: "delete_ledger", ledger_name: "KeepLedger" },
      );
      // Should return ActionSignal with autoContinue: false
      assert.equal(typeof raw, "object");
      assert.equal(raw.autoContinue, false, "Should signal autoContinue: false on cancellation");
      assert.ok(raw.result.includes("cancelad"), `Should be cancelled, got: ${raw.result}`);

      // Verify ledger still exists
      const { rows } = await db.sql`SELECT * FROM ledgers WHERE name = 'KeepLedger'`;
      assert.equal(rows.length, 1);
    },

    // --- per-ledger isolation ---
    async function history_filters_by_ledger(action_fn, db) {
      await ensureSchema(db);
      const l1 = await getOrCreateLedger(db, "LedgerA");
      const l2 = await getOrCreateLedger(db, "LedgerB");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l1.id}, 'StoreA', 10.00)`;
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l2.id}, 'StoreB', 20.00)`;

      const resultA = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "history", ledger_name: "LedgerA" },
      );
      assert.ok(resultA.includes("StoreA"), `Should include StoreA, got: ${resultA}`);
      assert.ok(!resultA.includes("StoreB"), `Should NOT include StoreB, got: ${resultA}`);

      const resultB = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "history", ledger_name: "LedgerB" },
      );
      assert.ok(resultB.includes("StoreB"), `Should include StoreB, got: ${resultB}`);
      assert.ok(!resultB.includes("StoreA"), `Should NOT include StoreA, got: ${resultB}`);
    },

    async function summary_filters_by_ledger(action_fn, db) {
      await ensureSchema(db);
      const l1 = await getOrCreateLedger(db, "SumLedger1");
      const l2 = await getOrCreateLedger(db, "SumLedger2");
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l1.id}, 'SumStore1', 100.00)`;
      await db.sql`INSERT INTO purchases (ledger_id, store_name, total) VALUES (${l2.id}, 'SumStore2', 200.00)`;

      const result = await action_fn(
        { db, callLlm: async () => null, content: [], log: async () => "", confirm: async () => true },
        { action: "summary", ledger_name: "SumLedger1" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("100.00"), `Should show 100.00, got: ${result}`);
      assert.ok(!result.includes("200.00"), `Should NOT show 200.00, got: ${result}`);
    },
  ],
  prompt: () => EXTRACT_PROMPT,
  test_prompts: [
    async function tool_selection_scenarios(callLlm, readFixture) {
      const { actionsToOpenAIFormat } = await import("../message-formatting.js");
      const config = (await import("../config.js")).default;
      const fs = await import("fs/promises");
      const path = await import("path");

      // Load all actions for realistic tool list
      const actionsDir = path.resolve(process.cwd(), "actions");
      const files = (await fs.readdir(actionsDir)).filter(f => f.endsWith(".js"));
      /** @type {Action[]} */
      const allActions = [];
      for (const file of files) {
        const mod = await import(`file://${path.join(actionsDir, file)}`);
        if (mod.default?.name) allActions.push(mod.default);
      }
      const tools = actionsToOpenAIFormat(allActions);

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
            { role: "assistant", content: null, tool_calls: [{ id: "call_prev", type: "function", function: { name: "track_purchases", arguments: '{"action":"extract"}' } }] },
            { role: "tool", content: "Factura registrada (ID: 1) — Libro: General\nTienda: Mercadona\nTotal: €25.30", tool_call_id: "call_prev" },
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
            const toolCalls = response.choices[0]?.message?.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
              return { name: scenario.name, error: "LLM should produce tool_calls for a receipt image" };
            }
            const call = toolCalls.find(tc => tc.function.name === "track_purchases");
            if (!call) {
              return { name: scenario.name, error: `Expected track_purchases call, got: ${toolCalls.map(tc => tc.function.name).join(", ")}` };
            }
            const args = JSON.parse(call.function.arguments);
            if (args.action !== "extract") {
              return { name: scenario.name, error: `Expected action='extract', got '${args.action}'` };
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
    },
    async function extract_from_receipt_image(callLlm, readFixture, prompt) {
      const imageBuffer = await readFixture("receipt-1.jpeg");
      const base64 = imageBuffer.toString("base64");

      /** @type {ContentBlock[]} */
      const content = [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: base64 },
        { type: "text", text: prompt() },
      ];

      const response = await callLlm(content);
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
    },
  ],
  action_fn: async function (context, params) {
    const { db, callLlm, content, log, confirm } = context;

    await ensureSchema(db);

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

      const ledgerName = params.ledger_name || "General";
      const ledger = await getOrCreateLedger(db, ledgerName);

      // Show preview and ask for confirmation
      const preview = formatPreview(data, ledger.name);
      const confirmed = await confirm(preview);
      if (!confirmed) {
        return { result: "Registro cancelado.", autoContinue: false };
      }

      const purchaseId = await db.transaction(async (/** @type {import("@electric-sql/pglite").Transaction} */ tx) => {
        const { rows } = await tx.sql`
          INSERT INTO purchases (ledger_id, store_name, purchase_date, total, notes)
          VALUES (${ledger.id}, ${data.store_name || "Desconocido"}, ${data.purchase_date}, ${data.total || 0}, ${""})
          RETURNING id
        `;
        const id = rows[0].id;

        if (data.items && data.items.length > 0) {
          for (const item of data.items) {
            await tx.sql`
              INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal)
              VALUES (${id}, ${item.item_name}, ${item.quantity || 1}, ${item.unit_price || 0}, ${item.subtotal || 0})
            `;
          }
        }

        return id;
      });

      let result = `*Factura registrada* (ID: ${purchaseId}) — Libro: ${ledger.name}\n\n`;
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
      return getHistory(db, params.ledger_name);

    } else if (params.action === "summary") {
      return getSummary(db, params.ledger_name);

    } else if (params.action === "delete") {
      if (!params.purchase_id) {
        return "Necesito el ID de la compra a eliminar. Usa !compras para ver el historial.";
      }
      const { rows } = await db.sql`
        DELETE FROM purchases WHERE id = ${params.purchase_id} RETURNING id, store_name
      `;
      if (rows.length === 0) {
        return `No se encontro la compra con ID ${params.purchase_id}`;
      }
      return `Compra #${rows[0].id} (${rows[0].store_name}) eliminada correctamente.`;

    } else if (params.action === "list_ledgers") {
      const { rows } = await db.sql`
        SELECT l.id, l.name, COUNT(p.id) as purchase_count, COALESCE(SUM(p.total), 0) as total_spent
        FROM ledgers l
        LEFT JOIN purchases p ON p.ledger_id = l.id
        GROUP BY l.id, l.name
        ORDER BY l.name
      `;

      if (rows.length === 0) {
        return "No hay libros de compras creados aun.";
      }

      let result = "*Libros de Compras*\n\n";
      for (const l of rows) {
        result += `• *${l.name}* — ${l.purchase_count} compras — €${Number(l.total_spent).toFixed(2)}\n`;
      }
      return result;

    } else if (params.action === "rename_ledger") {
      if (!params.ledger_name) {
        return "Necesito el nombre del libro a renombrar (ledger_name).";
      }
      if (!params.new_ledger_name) {
        return "Necesito el nuevo nombre para el libro (new_ledger_name).";
      }

      const { rows } = await db.sql`
        UPDATE ledgers SET name = ${params.new_ledger_name}
        WHERE LOWER(name) = LOWER(${params.ledger_name})
        RETURNING id, name
      `;
      if (rows.length === 0) {
        return `No se encontro el libro "${params.ledger_name}".`;
      }
      return `Libro renombrado a "${rows[0].name}".`;

    } else if (params.action === "delete_ledger") {
      if (!params.ledger_name) {
        return "Necesito el nombre del libro a eliminar (ledger_name).";
      }

      const { rows: ledgerRows } = await db.sql`
        SELECT id, name FROM ledgers WHERE LOWER(name) = LOWER(${params.ledger_name})
      `;
      if (ledgerRows.length === 0) {
        return `No se encontro el libro "${params.ledger_name}".`;
      }

      const { rows: countRows } = await db.sql`
        SELECT COUNT(*) as count FROM purchases WHERE ledger_id = ${ledgerRows[0].id}
      `;
      const count = Number(countRows[0].count);

      const confirmed = await confirm(
        `⚠️ *Eliminar libro "${ledgerRows[0].name}"*\n\n` +
        `Se eliminaran ${count} compra(s) asociadas.\n\n` +
        `React 👍 para confirmar o 👎 para cancelar.`
      );
      if (!confirmed) {
        return { result: "Eliminacion cancelada.", autoContinue: false };
      }

      await db.sql`DELETE FROM ledgers WHERE id = ${ledgerRows[0].id}`;
      return `Libro "${ledgerRows[0].name}" eliminado con ${count} compra(s).`;
    }

    return "Accion no reconocida. Usa: extract, history, summary, delete, list_ledgers, rename_ledger o delete_ledger.";
  }
});
