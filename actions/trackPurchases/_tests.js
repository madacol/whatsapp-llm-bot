import assert from "node:assert/strict";
import {
  ensureSchema,
  getOrCreateLedger,
  computeItemsTotal,
  computeDiscountsTotal,
  computeProportionalDiscounts,
  formatPreview,
} from "./index.js";

/** @type {ActionDbTestFn[]} */
export default [
async function history_empty(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
        { action: "summary" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Total compras"));
    },
    async function delete_nonexistent(action_fn, db) {
      await ensureSchema(db);
      const result = await action_fn(
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
      // Simulates the Dunnes receipt e2e: LLM passes ALL items with included flags
      // Full receipt: 14 items summing to 129.21, discounts=50.84, paid=78.37
      // Included (5): eggs(11.97) + rice cakes(10.00) + lettuce(2.10) + pineapple(2.99) + lemsip(7.75) = 34.81
      // Excluded (9): sum to 94.40
      // Proportional discount: 34.81/129.21 × 50.84 = 13.70 (ratio=0.26940...)
      // Paid: 34.81 - 13.70 = 21.11
      const items = JSON.stringify([
        // Included items
        { item_name: "DS Medium Eggs", quantity: 3, unit_price: 3.99, subtotal: 11.97, included: true },
        { item_name: "DS Rice Cake", quantity: 5, unit_price: 2.00, subtotal: 10.00, included: true },
        { item_name: "Iceberg Lettuce", quantity: 2, unit_price: 1.05, subtotal: 2.10, included: true },
        { item_name: "Large Pineapple", quantity: 1, unit_price: 2.99, subtotal: 2.99, included: true },
        { item_name: "Lemsip", quantity: 1, unit_price: 7.75, subtotal: 7.75, included: true },
        // Excluded items (sum=94.40, so allItemsSum=129.21)
        { item_name: "DS Whole Milk 2L", quantity: 2, unit_price: 1.89, subtotal: 3.78, included: false },
        { item_name: "DS Butter 227g", quantity: 1, unit_price: 2.49, subtotal: 2.49, included: false },
        { item_name: "DS Sliced Pan", quantity: 2, unit_price: 1.69, subtotal: 3.38, included: false },
        { item_name: "Bananas Loose", quantity: 1, unit_price: 1.29, subtotal: 1.29, included: false },
        { item_name: "DS Chicken Fillets", quantity: 2, unit_price: 5.99, subtotal: 11.98, included: false },
        { item_name: "DS Cheddar 200g", quantity: 1, unit_price: 3.49, subtotal: 3.49, included: false },
        { item_name: "DS Kitchen Roll 4pk", quantity: 1, unit_price: 3.50, subtotal: 3.50, included: false },
        { item_name: "DS Nappies 48pk", quantity: 1, unit_price: 24.99, subtotal: 24.99, included: false },
        { item_name: "DS Baby Formula", quantity: 1, unit_price: 39.50, subtotal: 39.50, included: false },
      ]);
      const discounts = JSON.stringify([
        { description: "Employee Discount", amount: 25.84 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 5.00 },
      ]);
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
        { action: "register", store_name: "Dunnes Stores", purchase_date: "2026-03-02", items, discounts, total },
      );

      assert.ok(typeof result === "string");
      assert.ok(result.includes("Dunnes Stores"));
      assert.ok(result.includes("DS Medium Eggs"));
      assert.ok(result.includes("Lemsip"));
      // Excluded items should NOT appear in result
      assert.ok(!result.includes("DS Whole Milk"), `Excluded items should not appear in result, got:\n${result}`);

      // Preview should show proportional discounts
      assert.ok(capturedPreview, "confirm should have been called");
      assert.ok(capturedPreview.includes("Suma items: €34.81"), `Should show included items sum, got:\n${capturedPreview}`);
      assert.ok(capturedPreview.includes("Employee Discount"), `Should show discount, got:\n${capturedPreview}`);
      assert.ok(!capturedPreview.includes("⚠️"), `Should NOT warn for valid receipt, got:\n${capturedPreview}`);

      // Verify DB: purchase total = proportional paid amount
      const { rows: purchases } = await db.sql`SELECT * FROM purchases WHERE store_name = 'Dunnes Stores'`;
      assert.equal(purchases.length, 1);
      const storedTotal = Number(purchases[0].total);
      // ratio = 34.81/129.21 = 0.26940…
      // proportional discounts: 25.84×r=6.96, 10×r=2.69, 10×r=2.69, 5×r=1.35 → sum=13.69 (after per-item rounding)
      // but computeDiscountsTotal rounds: 6.96+2.69+2.69+1.35 = 13.69
      // paidAmount = round((34.81−13.69)×100)/100 = 21.12
      assert.equal(storedTotal, 21.12, `Stored total should be 21.12, got ${storedTotal}`);

      // Verify DB: only included items stored
      const { rows: dbItems } = await db.sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchases[0].id}`;
      assert.equal(dbItems.length, 5);

      // Verify DB: proportional discounts stored
      const { rows: dbDiscounts } = await db.sql`SELECT * FROM purchase_discounts WHERE purchase_id = ${purchases[0].id}`;
      assert.equal(dbDiscounts.length, 4, "Should store 4 proportional discounts");
      const discountsTotal = dbDiscounts.reduce((/** @type {number} */ sum, /** @type {{amount: string}} */ d) => sum + Number(d.amount), 0);
      const roundedDiscountsTotal = Math.round(discountsTotal * 100) / 100;
      assert.equal(roundedDiscountsTotal, 13.69, `Proportional discounts should sum to 13.69, got ${roundedDiscountsTotal}`);

      // Result message should show computed amounts
      assert.ok(result.includes("Subtotal: €34.81"), `Should show subtotal, got:\n${result}`);
      assert.ok(result.includes("Total pagado: €21.12"), `Should show paid total, got:\n${result}`);
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
      // Should return { result, autoContinue: false }
      const signal = /** @type {ActionResult} */ (/** @type {unknown} */ (raw));
      assert.equal(typeof signal, "object");
      assert.equal(signal.autoContinue, false, "Should signal autoContinue: false on cancellation");
      assert.ok(/** @type {string} */ (signal.result).includes("cancelad"), `Expected cancellation message, got: ${signal.result}`);

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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => false },
        { action: "delete_ledger", ledger_name: "KeepLedger" },
      );
      // Should return { result, autoContinue: false }
      const signal = /** @type {ActionResult} */ (/** @type {unknown} */ (raw));
      assert.equal(typeof signal, "object");
      assert.equal(signal.autoContinue, false, "Should signal autoContinue: false on cancellation");
      assert.ok(/** @type {string} */ (signal.result).includes("cancelad"), `Should be cancelled, got: ${signal.result}`);

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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
        { action: "history", ledger_name: "LedgerA" },
      );
      assert.ok(resultA.includes("StoreA"), `Should include StoreA, got: ${resultA}`);
      assert.ok(!resultA.includes("StoreB"), `Should NOT include StoreB, got: ${resultA}`);

      const resultB = await action_fn(
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
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
        { db, callLlm: /** @type {CallLlm} */ (/** @type {Function} */ (async () => null)), content: [], log: async () => "", confirm: async () => true },
        { action: "summary", ledger_name: "SumLedger1" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("100.00"), `Should show 100.00, got: ${result}`);
      assert.ok(!result.includes("200.00"), `Should NOT show 200.00, got: ${result}`);
    },
];
