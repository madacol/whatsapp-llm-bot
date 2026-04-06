import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  ensurePurchasesSchema,
  getPurchaseHistory,
  getPurchaseSummary,
  registerPreparedPurchase,
} from "../capabilities/purchases/store.js";
import { preparePurchaseRegistration } from "../capabilities/purchases/math.js";

describe("purchase capabilities", () => {
  it("registers a prepared receipt directly without the action adapter", async (t) => {
    const db = new PGlite("memory://");
    t.after(async () => {
      await db.close();
    });

    await ensurePurchasesSchema(db);

    const prepared = preparePurchaseRegistration({
      storeName: "Capability Market",
      purchaseDate: "2026-03-02",
      ledgerName: "Groceries",
      receiptTotal: 78.37,
      items: [
        { item_name: "DS Medium Eggs", quantity: 3, unit_price: 3.99, subtotal: 11.97, included: true },
        { item_name: "DS Rice Cake", quantity: 5, unit_price: 2.00, subtotal: 10.00, included: true },
        { item_name: "Iceberg Lettuce", quantity: 2, unit_price: 1.05, subtotal: 2.10, included: true },
        { item_name: "Large Pineapple", quantity: 1, unit_price: 2.99, subtotal: 2.99, included: true },
        { item_name: "Lemsip", quantity: 1, unit_price: 7.75, subtotal: 7.75, included: true },
        { item_name: "DS Whole Milk 2L", quantity: 2, unit_price: 1.89, subtotal: 3.78, included: false },
        { item_name: "DS Butter 227g", quantity: 1, unit_price: 2.49, subtotal: 2.49, included: false },
        { item_name: "DS Sliced Pan", quantity: 2, unit_price: 1.69, subtotal: 3.38, included: false },
        { item_name: "Bananas Loose", quantity: 1, unit_price: 1.29, subtotal: 1.29, included: false },
        { item_name: "DS Chicken Fillets", quantity: 2, unit_price: 5.99, subtotal: 11.98, included: false },
        { item_name: "DS Cheddar 200g", quantity: 1, unit_price: 3.49, subtotal: 3.49, included: false },
        { item_name: "DS Kitchen Roll 4pk", quantity: 1, unit_price: 3.50, subtotal: 3.50, included: false },
        { item_name: "DS Nappies 48pk", quantity: 1, unit_price: 24.99, subtotal: 24.99, included: false },
        { item_name: "DS Baby Formula", quantity: 1, unit_price: 39.50, subtotal: 39.50, included: false },
      ],
      discounts: [
        { description: "Employee Discount", amount: 25.84 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 10.00 },
        { description: "Discount Voucher", amount: 5.00 },
      ],
    });

    const saved = await registerPreparedPurchase(db, prepared);
    assert.equal(saved.ledger.name, "Groceries");
    assert.ok(saved.purchaseId > 0);

    const history = await getPurchaseHistory(db, { ledgerName: "Groceries" });
    assert.equal(history.ledgerName, "Groceries");
    assert.equal(history.purchases.length, 1);
    assert.equal(history.purchases[0].items.length, 5);
    assert.equal(history.purchases[0].discounts.length, 4);
    assert.equal(history.purchases[0].total, 21.12);
    assert.equal(history.purchases[0].items[0].item_name, "DS Medium Eggs");
  });

  it("summarizes purchases by ledger directly from the capability layer", async (t) => {
    const db = new PGlite("memory://");
    t.after(async () => {
      await db.close();
    });

    await ensurePurchasesSchema(db);

    const groceryPurchase = preparePurchaseRegistration({
      storeName: "Grocer",
      purchaseDate: "2026-04-01",
      ledgerName: "Groceries",
      receiptTotal: 12.5,
      items: [
        { item_name: "Tomatoes", quantity: 2, unit_price: 2.50, subtotal: 5.00 },
        { item_name: "Bread", quantity: 3, unit_price: 2.50, subtotal: 7.50 },
      ],
      discounts: [],
    });
    await registerPreparedPurchase(db, groceryPurchase);

    const officePurchase = preparePurchaseRegistration({
      storeName: "Stationer",
      purchaseDate: "2026-04-02",
      ledgerName: "Office",
      receiptTotal: 15,
      items: [
        { item_name: "Pens", quantity: 5, unit_price: 1.00, subtotal: 5.00 },
        { item_name: "Notebook", quantity: 2, unit_price: 5.00, subtotal: 10.00 },
      ],
      discounts: [],
    });
    await registerPreparedPurchase(db, officePurchase);

    const summary = await getPurchaseSummary(db, {});
    assert.equal(summary.totalPurchases, 2);
    assert.equal(summary.totalSpent, 27.5);
    assert.deepEqual(
      summary.byLedger.map((entry) => entry.ledgerName),
      ["Office", "Groceries"],
    );

    const groceriesOnly = await getPurchaseSummary(db, { ledgerName: "Groceries" });
    assert.equal(groceriesOnly.ledgerName, "Groceries");
    assert.equal(groceriesOnly.totalPurchases, 1);
    assert.equal(groceriesOnly.totalSpent, 12.5);
    assert.equal(groceriesOnly.byLedger.length, 0);
    assert.equal(groceriesOnly.byStore[0].storeName, "Grocer");
  });
});
