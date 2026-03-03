import assert from "node:assert/strict";

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
  await db.sql`
    CREATE TABLE IF NOT EXISTS purchase_discounts (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
      description TEXT,
      amount NUMERIC(12,2)
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
 * Sum all item subtotals, rounded to 2 decimals.
 * @param {Array<{subtotal: number}>} items
 * @returns {number}
 */
function computeItemsTotal(items) {
  const sum = items.reduce((acc, item) => acc + (item.subtotal || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Sum all discount amounts, rounded to 2 decimals.
 * @param {Array<{amount: number}>} discounts
 * @returns {number}
 */
function computeDiscountsTotal(discounts) {
  const sum = discounts.reduce((acc, d) => acc + (d.amount || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Compute proportional discount for included items.
 * @param {number} includedSum - sum of included items
 * @param {number} allItemsSum - sum of all receipt items
 * @param {Array<{description: string, amount: number}>} discounts - all receipt discounts
 * @returns {{ proportionalDiscounts: Array<{description: string, amount: number}>, discountsSum: number, paidAmount: number }}
 */
function computeProportionalDiscounts(includedSum, allItemsSum, discounts) {
  if (discounts.length === 0 || allItemsSum === 0) {
    return { proportionalDiscounts: [], discountsSum: 0, paidAmount: includedSum };
  }
  const ratio = includedSum / allItemsSum;
  const proportionalDiscounts = discounts.map(d => ({
    description: d.description,
    amount: Math.round(d.amount * ratio * 100) / 100,
  }));
  const discountsSum = computeDiscountsTotal(proportionalDiscounts);
  const paidAmount = Math.round((includedSum - discountsSum) * 100) / 100;
  return { proportionalDiscounts, discountsSum, paidAmount };
}

/**
 * Format a receipt preview for confirmation.
 * @param {{ store_name: string|null, purchase_date: string|null, includedItems: Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>, proportionalDiscounts: Array<{description: string, amount: number}>, discountsSum: number, paidAmount: number, receiptValidation?: string|null }} data
 * @param {string} ledgerName
 * @returns {string}
 */
function formatPreview(data, ledgerName) {
  let preview = `*Vista previa de factura*\n`;
  preview += `*Libro:* ${ledgerName}\n`;
  preview += `*Tienda:* ${data.store_name || "No identificada"}\n`;
  preview += `*Fecha:* ${data.purchase_date || "No identificada"}\n\n`;
  preview += `*Items:*\n`;
  if (data.includedItems && data.includedItems.length > 0) {
    for (const [i, item] of data.includedItems.entries()) {
      const price = item.subtotal || item.unit_price || 0;
      preview += `  ${i + 1}. ${item.item_name} — x${item.quantity || 1} — €${Number(price).toFixed(2)}\n`;
    }
  }

  const itemsSum = computeItemsTotal(data.includedItems || []);
  preview += `\n*Suma items: €${itemsSum.toFixed(2)}*\n`;

  if (data.proportionalDiscounts.length > 0) {
    preview += `*Descuentos (proporcional):*\n`;
    for (const d of data.proportionalDiscounts) {
      preview += `  • ${d.description} — -€${Number(d.amount).toFixed(2)}\n`;
    }
    preview += `*Total descuentos: -€${data.discountsSum.toFixed(2)}*\n`;
  }

  preview += `*Total pagado: €${data.paidAmount.toFixed(2)}*\n`;

  if (data.receiptValidation) {
    preview += data.receiptValidation;
  }

  preview += `\nReact 👍 para guardar o 👎 para cancelar.`;
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
    const { rows: discounts } = await db.sql`SELECT * FROM purchase_discounts WHERE purchase_id = ${p.id}`;
    const prefix = ledgerName ? `*#${p.id}*` : `*#${p.id}* [${p.ledger_name}]`;
    result += `${prefix} — ${p.store_name || "?"} — ${p.purchase_date || "Sin fecha"}\n`;
    for (const item of items) {
      result += `  • ${item.item_name} x${item.quantity} — €${Number(item.subtotal).toFixed(2)}\n`;
    }
    if (discounts.length > 0) {
      for (const d of discounts) {
        result += `  🏷️ ${d.description} — -€${Number(d.amount).toFixed(2)}\n`;
      }
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

export { ensureSchema, getOrCreateLedger, formatPreview, computeItemsTotal, computeDiscountsTotal, computeProportionalDiscounts };

export default /** @type {defineAction} */ ((x) => x)({
  name: "track_purchases",
  command: "compras",
  optIn: true,
  description: "Register purchase data and manage purchase history. To process a receipt/invoice image: first call extract_from_image to extract the data, then call this with action='register' passing the items to register, ALL discounts, receipt_subtotal (sum of ALL receipt items), and total (amount paid). The action computes proportional discounts for selected items automatically. Also use for: purchase history ('history'), spending summary ('summary'), deleting a purchase ('delete'), and ledger management ('list_ledgers', 'rename_ledger', 'delete_ledger').",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action to perform: 'register' to save pre-extracted purchase data, 'history' for purchase history, 'summary' for spending summary, 'delete' to delete a record by ID, 'list_ledgers' to list ledgers, 'rename_ledger' to rename a ledger, 'delete_ledger' to delete a ledger and its purchases",
        enum: ["register", "history", "summary", "delete", "list_ledgers", "rename_ledger", "delete_ledger"]
      },
      store_name: {
        type: "string",
        description: "Store/vendor name (for action=register)"
      },
      purchase_date: {
        type: "string",
        description: "Purchase date in YYYY-MM-DD format (for action=register)"
      },
      items: {
        type: "string",
        description: "JSON array of items to register, each with {item_name, quantity, unit_price, subtotal}. Only include items the user wants to track."
      },
      discounts: {
        type: "string",
        description: "JSON array of ALL discounts from the receipt, each with {description, amount}. Include employee discounts, vouchers, coupons, etc."
      },
      receipt_subtotal: {
        type: "number",
        description: "Full receipt subtotal before discounts (sum of ALL items on the receipt, not just the selected ones). Required when discounts are provided, used to compute proportional discounts for the selected items."
      },
      total: {
        type: "number",
        description: "Total amount paid on the receipt after all discounts (BAL TO PAY). Used for validation."
      },
      purchase_id: {
        type: "string",
        description: "ID of the purchase to delete (for action=delete)"
      },
      ledger_name: {
        type: "string",
        description: "Ledger name. For 'register': ledger to save to (default: 'General'). For 'history'/'summary': filter by ledger. For 'rename_ledger'/'delete_ledger': ledger to modify."
      },
      new_ledger_name: {
        type: "string",
        description: "New name for the ledger (for action=rename_ledger)"
      }
    },
    required: ["action"]
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
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
    async function register_saves_purchase(action_fn, db) {
      await ensureSchema(db);
      const items = JSON.stringify([
        { item_name: "Pan", quantity: 1, unit_price: 1.20, subtotal: 1.20 },
        { item_name: "Agua", quantity: 2, unit_price: 0.50, subtotal: 1.00 },
      ]);
      const result = await action_fn(
        { db, content: [], log: async () => "", confirm: async () => true },
        { action: "register", store_name: "Supermercado Test", purchase_date: "2025-06-15", items, total: 2.20 },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Supermercado Test"));
      assert.ok(result.includes("Pan"));
      assert.ok(result.includes("2.20"));

      // Verify data was inserted
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'Supermercado Test'`;
      assert.equal(purchases.length, 1);
      const { rows: dbItems } = await db.sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchases[0].id} ORDER BY item_name`;
      assert.equal(dbItems.length, 2);

      // Verify default ledger was created
      const { rows: ledgers } = await db.sql`SELECT * FROM ledgers WHERE LOWER(name) = 'general'`;
      assert.equal(ledgers.length, 1);
      assert.equal(purchases[0].ledger_id, ledgers[0].id);
    },
    async function register_with_discounts_saves_and_validates(action_fn, db) {
      await ensureSchema(db);
      // Simulates the Dunnes receipt e2e: LLM passes selected items + receipt context
      // Full receipt: subtotal=129.21, discounts=50.84, paid=78.37
      // Selected items: eggs(3×3.99=11.97) + rice cakes(5×2.00=10.00)
      //   + lettuce(2×1.05=2.10) + pineapple(2.99) + lemsip(7.75) = 34.81
      // Action computes proportional discount: 34.81 × (50.84/129.21) ≈ 13.69
      // Action computes paid: 34.81 - 13.69 = 21.12
      const items = JSON.stringify([
        { item_name: "DS Medium Eggs", quantity: 3, unit_price: 3.99, subtotal: 11.97 },
        { item_name: "DS Rice Cake", quantity: 5, unit_price: 2.00, subtotal: 10.00 },
        { item_name: "Iceberg Lettuce", quantity: 2, unit_price: 1.05, subtotal: 2.10 },
        { item_name: "Large Pineapple", quantity: 1, unit_price: 2.99, subtotal: 2.99 },
        { item_name: "Lemsip", quantity: 1, unit_price: 7.75, subtotal: 7.75 },
      ]);
      const discounts = JSON.stringify([
        { description: "Employee Discount", amount: 25.84 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 5.00 },
      ]);
      const receipt_subtotal = 129.21; // full receipt subtotal
      const total = 78.37; // receipt paid total

      /** @type {string | undefined} */
      let capturedPreview;
      const result = await action_fn(
        {
          db,
          content: [],
          log: async () => "",
          confirm: async (/** @type {string} */ preview) => { capturedPreview = preview; return true; },
        },
        { action: "register", store_name: "Dunnes Stores", purchase_date: "2026-03-02", items, discounts, receipt_subtotal, total },
      );

      assert.ok(typeof result === "string");
      assert.ok(result.includes("Dunnes Stores"));
      assert.ok(result.includes("DS Medium Eggs"));
      assert.ok(result.includes("Lemsip"));

      // Preview should show proportional discounts
      assert.ok(capturedPreview, "confirm should have been called");
      assert.ok(capturedPreview.includes("Suma items: €34.81"), `Should show included items sum, got:\n${capturedPreview}`);
      assert.ok(capturedPreview.includes("Employee Discount"), `Should show discount, got:\n${capturedPreview}`);
      assert.ok(!capturedPreview.includes("⚠️"), `Should NOT warn for valid receipt, got:\n${capturedPreview}`);

      // Verify DB: purchase — total should be the computed paid amount (~21.12)
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'Dunnes Stores'`;
      assert.equal(purchases.length, 1);
      const storedTotal = Number(purchases[0].total);
      assert.ok(
        Math.abs(storedTotal - 21.12) < 0.10,
        `Stored total should be ~21.12 (proportional), got ${storedTotal}`,
      );

      // Verify DB: only selected items stored
      const { rows: dbItems } = await db.sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchases[0].id}`;
      assert.equal(dbItems.length, 5);

      // Verify DB: proportional discounts stored
      const { rows: dbDiscounts } = await db.sql`SELECT * FROM purchase_discounts WHERE purchase_id = ${purchases[0].id}`;
      assert.ok(dbDiscounts.length > 0, "Should store proportional discounts");
      const discountsTotal = dbDiscounts.reduce((/** @type {number} */ sum, /** @type {{amount: string}} */ d) => sum + Number(d.amount), 0);
      // 34.81/129.21 * 50.84 ≈ 13.70
      assert.ok(
        Math.abs(discountsTotal - 13.70) < 0.10,
        `Proportional discounts should sum to ~13.70, got ${discountsTotal.toFixed(2)}`,
      );

      // Result message should show computed amounts
      assert.ok(result.includes("Subtotal: €34.81"), `Should show subtotal, got:\n${result}`);
      assert.ok(
        result.includes(`Total pagado: €${storedTotal.toFixed(2)}`),
        `Should show paid total, got:\n${result}`,
      );
    },
    async function register_preview_shows_mismatch_warning(action_fn, db) {
      await ensureSchema(db);
      // Items sum to 12.50 but receipt total is 10.00 — should warn
      const items = JSON.stringify([
        { item_name: "Jamon", quantity: 1, unit_price: 8.00, subtotal: 8.00 },
        { item_name: "Queso", quantity: 1, unit_price: 4.50, subtotal: 4.50 },
      ]);
      /** @type {string | undefined} */
      let capturedPreview;
      const result = await action_fn(
        {
          db,
          content: [],
          log: async () => "",
          confirm: async (/** @type {string} */ preview) => { capturedPreview = preview; return true; },
        },
        { action: "register", store_name: "DiscountStore", purchase_date: "2025-08-01", items, total: 10.00 },
      );
      assert.ok(typeof result === "string");
      assert.ok(capturedPreview, "confirm should have been called with a preview");
      assert.ok(capturedPreview.includes("⚠️"), `Preview should show warning when items sum (12.50) ≠ receipt total (10.00), got:\n${capturedPreview}`);
    },
    async function register_missing_items(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { db, content: [], log: async () => "", confirm: async () => true },
        { action: "register", store_name: "Test", total: 10.00 },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("items"), `Should mention missing items, got: ${result}`);
    },
    async function computeItemsTotal_sums_subtotals(_action_fn, _db) {
      const items = [
        { item_name: "Pan", quantity: 1, unit_price: 1.20, subtotal: 1.20 },
        { item_name: "Agua", quantity: 2, unit_price: 0.50, subtotal: 1.00 },
        { item_name: "Leche", quantity: 1, unit_price: 1.50, subtotal: 1.50 },
      ];
      assert.equal(computeItemsTotal(items), 3.70);
    },
    async function computeItemsTotal_handles_empty(_action_fn, _db) {
      assert.equal(computeItemsTotal([]), 0);
    },
    async function computeDiscountsTotal_sums_amounts(_action_fn, _db) {
      const discounts = [
        { description: "Employee Discount", amount: 25.84 },
        { description: "Voucher 1", amount: 10.00 },
        { description: "Voucher 2", amount: 10.00 },
        { description: "Voucher 3", amount: 5.00 },
      ];
      assert.equal(computeDiscountsTotal(discounts), 50.84);
    },
    async function computeDiscountsTotal_handles_empty(_action_fn, _db) {
      assert.equal(computeDiscountsTotal([]), 0);
    },
    async function formatPreview_shows_matching_totals(_action_fn, _db) {
      const data = {
        store_name: "TestStore",
        purchase_date: "2025-01-01",
        includedItems: [
          { item_name: "Item1", quantity: 1, unit_price: 5.00, subtotal: 5.00 },
          { item_name: "Item2", quantity: 2, unit_price: 1.50, subtotal: 3.00 },
        ],
        proportionalDiscounts: [],
        discountsSum: 0,
        paidAmount: 8.00,
      };
      const preview = formatPreview(data, "General");
      assert.ok(preview.includes("Suma items: €8.00"), `Should show items sum, got:\n${preview}`);
      assert.ok(preview.includes("Total pagado: €8.00"), `Should show paid total, got:\n${preview}`);
      assert.ok(!preview.includes("⚠️"), `Should NOT show warning when totals match, got:\n${preview}`);
    },
    async function formatPreview_shows_discounts(_action_fn, _db) {
      const data = {
        store_name: "Dunnes",
        purchase_date: "2026-03-02",
        includedItems: [
          { item_name: "Eggs", quantity: 3, unit_price: 3.99, subtotal: 11.97 },
          { item_name: "Rice Cake", quantity: 5, unit_price: 2.00, subtotal: 10.00 },
        ],
        proportionalDiscounts: [
          { description: "Employee Discount", amount: 5.00 },
          { description: "Discount Voucher", amount: 3.00 },
        ],
        discountsSum: 8.00,
        paidAmount: 13.97,
      };
      const preview = formatPreview(data, "General");
      assert.ok(preview.includes("Suma items: €21.97"), `Should show items sum, got:\n${preview}`);
      assert.ok(preview.includes("Employee Discount"), `Should show discount description, got:\n${preview}`);
      assert.ok(preview.includes("-€5.00"), `Should show discount amount, got:\n${preview}`);
      assert.ok(preview.includes("Total descuentos: -€8.00"), `Should show discounts total, got:\n${preview}`);
      assert.ok(preview.includes("Total pagado: €13.97"), `Should show paid total, got:\n${preview}`);
      assert.ok(!preview.includes("⚠️"), `Should NOT show warning, got:\n${preview}`);
    },
    async function formatPreview_shows_receipt_validation_warning(_action_fn, _db) {
      const data = {
        store_name: "TestStore",
        purchase_date: "2025-01-01",
        includedItems: [
          { item_name: "Item1", quantity: 1, unit_price: 10.00, subtotal: 10.00 },
        ],
        proportionalDiscounts: [],
        discountsSum: 0,
        paidAmount: 10.00,
        receiptValidation: "⚠️ Receipt math does not add up.\n",
      };
      const preview = formatPreview(data, "General");
      assert.ok(preview.includes("⚠️"), `Should show receipt validation warning, got:\n${preview}`);
    },
    async function computeProportionalDiscounts_calculates_correctly(_action_fn, _db) {
      // Full receipt: 129.21 subtotal, 50.84 discounts
      // Selected items: 34.81
      // Expected ratio: 34.81 / 129.21 = 0.2694...
      const discounts = [
        { description: "Employee Discount", amount: 25.84 },
        { description: "Voucher", amount: 25.00 },
      ];
      const result = computeProportionalDiscounts(34.81, 129.21, discounts);

      // Proportional employee discount: 25.84 * (34.81/129.21) ≈ 6.96
      assert.ok(
        Math.abs(result.proportionalDiscounts[0].amount - 6.96) < 0.02,
        `Employee discount should be ~6.96, got ${result.proportionalDiscounts[0].amount}`,
      );
      // Proportional voucher: 25.00 * (34.81/129.21) ≈ 6.73
      assert.ok(
        Math.abs(result.proportionalDiscounts[1].amount - 6.73) < 0.02,
        `Voucher discount should be ~6.73, got ${result.proportionalDiscounts[1].amount}`,
      );
      // Total discounts ≈ 13.69
      assert.ok(
        Math.abs(result.discountsSum - 13.69) < 0.02,
        `Total discounts should be ~13.69, got ${result.discountsSum}`,
      );
      // Paid ≈ 21.12
      assert.ok(
        Math.abs(result.paidAmount - 21.12) < 0.02,
        `Paid amount should be ~21.12, got ${result.paidAmount}`,
      );
    },
    async function computeProportionalDiscounts_no_discounts(_action_fn, _db) {
      const result = computeProportionalDiscounts(50.00, 50.00, []);
      assert.equal(result.proportionalDiscounts.length, 0);
      assert.equal(result.discountsSum, 0);
      assert.equal(result.paidAmount, 50.00);
    },
    // --- Confirmation flow ---
    async function register_cancelled_by_user(action_fn, db) {
      await ensureSchema(db);
      const items = JSON.stringify([
        { item_name: "Item1", quantity: 1, unit_price: 5.00, subtotal: 5.00 },
      ]);
      const raw = await action_fn(
        { db, content: [], log: async () => "", confirm: async () => false },
        { action: "register", store_name: "CancelStore", purchase_date: "2025-06-15", items, total: 5.00 },
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
    async function register_rolls_back_on_item_error(action_fn, db) {
      await ensureSchema(db);
      const items = JSON.stringify([
        { item_name: "GoodItem", quantity: 1, unit_price: 5.00, subtotal: 5.00 },
        { item_name: "BadItem", quantity: 1, unit_price: 1.00, subtotal: "not_a_number" },
      ]);
      try {
        await action_fn(
          { db, content: [], log: async () => "", confirm: async () => true },
          { action: "register", store_name: "AtomicStore", purchase_date: "2025-06-15", items, total: 6.00 },
        );
      } catch {
        // Expected to throw due to invalid NUMERIC value
      }

      // The purchase should NOT exist if the transaction rolled back
      const { rows } = await db.sql`SELECT * FROM purchases WHERE store_name = 'AtomicStore'`;
      assert.equal(rows.length, 0, "Purchase should be rolled back when item insert fails");
    },

    // --- Named ledger tests ---
    async function register_with_named_ledger(action_fn, db) {
      await ensureSchema(db);
      const items = JSON.stringify([
        { item_name: "ItemX", quantity: 1, unit_price: 10.00, subtotal: 10.00 },
      ]);
      const result = await action_fn(
        { db, content: [], log: async () => "", confirm: async () => true },
        { action: "register", store_name: "LedgerStore", purchase_date: "2025-07-01", items, total: 10.00, ledger_name: "Groceries" },
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
  test_prompts: [
    async function tool_selection_scenarios(callLlm, readFixture) {
      const { actionsToOpenAIFormat } = await import("../message-formatting.js");
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
            const toolCalls = response.choices[0]?.message?.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
              return { name: scenario.name, error: "LLM should produce tool_calls for a receipt image" };
            }
            const call = toolCalls.find(tc => tc.function.name === "extract_from_image");
            if (!call) {
              return { name: scenario.name, error: `Expected extract_from_image call, got: ${toolCalls.map(tc => tc.function.name).join(", ")}` };
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
      const { actionsToOpenAIFormat } = await import("../message-formatting.js");
      const { EXTRACT_PROMPT, parseExtractResponse } = await import("./tools/extractFromImage.js");
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
      const tools = actionsToOpenAIFormat(allActions);

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
      const toolCalls = response.choices?.[0]?.message?.tool_calls;
      assert.ok(toolCalls && toolCalls.length > 0, "LLM should call track_purchases");

      const registerCall = toolCalls.find((/** @type {{function: {name: string}}} */ tc) => tc.function.name === "track_purchases");
      assert.ok(registerCall, `Expected track_purchases call, got: ${toolCalls.map((/** @type {{function: {name: string}}} */ tc) => tc.function.name).join(", ")}`);

      const args = JSON.parse(registerCall.function.arguments);
      assert.equal(args.action, "register");

      // Validate: LLM should pass only the requested items
      const registeredItems = JSON.parse(args.items);
      assert.ok(registeredItems.length >= 4, `Should have at least 4 item groups, got ${registeredItems.length}`);
      assert.ok(registeredItems.length <= 10, `Should have at most 10 items, got ${registeredItems.length}`);

      const itemNames = registeredItems.map((/** @type {{item_name: string}} */ i) => i.item_name.toLowerCase()).join(" | ");
      for (const keyword of ["egg", "rice", "lettuce", "pineapple", "lemsip"]) {
        assert.ok(itemNames.includes(keyword), `Should include '${keyword}' in items, got: ${itemNames}`);
      }

      const itemsSum = registeredItems.reduce((/** @type {number} */ sum, /** @type {{subtotal: number}} */ i) => sum + i.subtotal, 0);
      assert.ok(
        Math.abs(itemsSum - 34.81) < 5.0,
        `Selected items should sum to ~34.81, got ${itemsSum.toFixed(2)}`,
      );

      // Validate: LLM should pass ALL discounts from receipt
      assert.ok(args.discounts, "Should include discounts");
      const passedDiscounts = JSON.parse(args.discounts);
      assert.ok(passedDiscounts.length >= 2, `Should pass all receipt discounts, got ${passedDiscounts.length}`);

      const discountsSum = passedDiscounts.reduce((/** @type {number} */ sum, /** @type {{amount: number}} */ d) => sum + d.amount, 0);
      assert.ok(
        Math.abs(discountsSum - 50.84) < 3.0,
        `Discounts should be full receipt amount ~50.84, got ${discountsSum.toFixed(2)}`,
      );

      // Validate: receipt_subtotal should be the full receipt subtotal
      assert.ok(args.receipt_subtotal, "Should include receipt_subtotal");
      assert.ok(
        Math.abs(args.receipt_subtotal - 129.21) < 2.0,
        `receipt_subtotal should be ~129.21, got ${args.receipt_subtotal}`,
      );

      // Validate: total should be the receipt paid total
      assert.ok(
        Math.abs(args.total - 78.37) < 2.0,
        `Total should be receipt paid amount ~78.37, got ${args.total}`,
      );

      console.log(`  ✔ items_sum=${itemsSum.toFixed(2)}, receipt_subtotal=${args.receipt_subtotal}, discounts=${discountsSum.toFixed(2)}, total=${args.total}`);
    },
  ],
  action_fn: async function (context, params) {
    const { db, log, confirm } = context;

    await ensureSchema(db);

    if (params.action === "register") {
      if (!params.items) {
        return "Missing items. Provide a JSON array of items with {item_name, quantity, unit_price, subtotal}.";
      }

      /** @type {Array<{item_name: string, quantity: number, unit_price: number, subtotal: number}>} */
      let items;
      try {
        items = JSON.parse(params.items);
      } catch {
        return "Could not parse items JSON. Provide a valid JSON array.";
      }

      /** @type {Array<{description: string, amount: number}>} */
      let discounts = [];
      if (params.discounts) {
        try {
          discounts = JSON.parse(params.discounts);
        } catch {
          return "Could not parse discounts JSON. Provide a valid JSON array.";
        }
      }

      const includedItems = items;
      const includedSum = computeItemsTotal(includedItems);
      // receipt_subtotal is the sum of ALL items on the receipt (needed for proportional discounts)
      const receiptSubtotal = Number(params.receipt_subtotal || includedSum);

      // Validate receipt integrity
      /** @type {string | null} */
      let receiptValidation = null;
      const receiptTotal = Number(params.total || 0);
      const discountsSum = computeDiscountsTotal(discounts);
      if (receiptTotal > 0) {
        const expected = Math.round((receiptSubtotal - discountsSum) * 100) / 100;
        if (Math.abs(expected - receiptTotal) > 1.0) {
          receiptValidation = `⚠️ Validacion recibo: items (€${receiptSubtotal.toFixed(2)}) - descuentos (€${discountsSum.toFixed(2)}) = €${expected.toFixed(2)}, pero el total del recibo es €${receiptTotal.toFixed(2)}.\n`;
        }
      }

      // Compute proportional discounts for selected items
      const { proportionalDiscounts, discountsSum: propDiscountsSum, paidAmount } =
        computeProportionalDiscounts(includedSum, receiptSubtotal, discounts);

      const previewData = {
        store_name: params.store_name || null,
        purchase_date: params.purchase_date || null,
        includedItems,
        proportionalDiscounts,
        discountsSum: propDiscountsSum,
        paidAmount,
        receiptValidation,
      };

      const ledgerName = params.ledger_name || "General";
      const ledger = await getOrCreateLedger(db, ledgerName);

      // Show preview and ask for confirmation
      const preview = formatPreview(previewData, ledger.name);
      const confirmed = await confirm(preview);
      if (!confirmed) {
        return { result: "Registro cancelado.", autoContinue: false };
      }

      const purchaseId = await db.transaction(async (/** @type {import("@electric-sql/pglite").Transaction} */ tx) => {
        const { rows } = await tx.sql`
          INSERT INTO purchases (ledger_id, store_name, purchase_date, total, notes)
          VALUES (${ledger.id}, ${params.store_name || "Desconocido"}, ${params.purchase_date || null}, ${paidAmount}, ${""})
          RETURNING id
        `;
        const id = rows[0].id;

        for (const item of includedItems) {
          await tx.sql`
            INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal)
            VALUES (${id}, ${item.item_name}, ${item.quantity || 1}, ${item.unit_price || 0}, ${item.subtotal || 0})
          `;
        }

        for (const discount of proportionalDiscounts) {
          await tx.sql`
            INSERT INTO purchase_discounts (purchase_id, description, amount)
            VALUES (${id}, ${discount.description}, ${discount.amount || 0})
          `;
        }

        return id;
      });

      let result = `*Factura registrada* (ID: ${purchaseId}) — Libro: ${ledger.name}\n\n`;
      result += `*Tienda:* ${params.store_name || "No identificada"}\n`;
      result += `*Fecha:* ${params.purchase_date || "No identificada"}\n\n`;
      result += `*Items:*\n`;

      for (const [i, item] of includedItems.entries()) {
        const price = item.subtotal || item.unit_price || 0;
        result += `  ${i + 1}. ${item.item_name} — x${item.quantity || 1} — €${Number(price).toFixed(2)}\n`;
      }

      result += `\n*Subtotal: €${includedSum.toFixed(2)}*\n`;
      if (proportionalDiscounts.length > 0) {
        for (const d of proportionalDiscounts) {
          result += `*${d.description}: -€${Number(d.amount).toFixed(2)}*\n`;
        }
        result += `*Total descuentos: -€${propDiscountsSum.toFixed(2)}*\n`;
      }
      result += `*Total pagado: €${paidAmount.toFixed(2)}*`;
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

    return "Accion no reconocida. Usa: register, history, summary, delete, list_ledgers, rename_ledger o delete_ledger.";
  }
});
