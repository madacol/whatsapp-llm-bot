/**
 * @typedef {{
 *   storeName: string | null,
 *   purchaseDate: string | null,
 *   ledgerName: string,
 *   allItems: import("./input.js").PurchaseItemInput[],
 *   includedItems: import("./input.js").PurchaseItemInput[],
 *   allItemsTotal: number,
 *   includedItemsTotal: number,
 *   receiptTotal: number | null,
 *   receiptDiscounts: import("./input.js").PurchaseDiscountInput[],
 *   receiptDiscountsTotal: number,
 *   proportionalDiscounts: import("./input.js").PurchaseDiscountInput[],
 *   proportionalDiscountsTotal: number,
 *   paidAmount: number,
 *   receiptValidation: string | null,
 * }} PreparedPurchaseRegistration
 */

/**
 * Sum all item subtotals, rounded to 2 decimals.
 * @param {Array<{subtotal: number}>} items
 * @returns {number}
 */
export function computeItemsTotal(items) {
  const sum = items.reduce((acc, item) => acc + item.subtotal, 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Sum all discount amounts, rounded to 2 decimals.
 * @param {Array<{amount: number}>} discounts
 * @returns {number}
 */
export function computeDiscountsTotal(discounts) {
  const sum = discounts.reduce((acc, discount) => acc + discount.amount, 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Compute proportional discount for included items.
 * @param {number} includedSum
 * @param {number} allItemsSum
 * @param {import("./input.js").PurchaseDiscountInput[]} discounts
 * @returns {{ proportionalDiscounts: import("./input.js").PurchaseDiscountInput[], discountsSum: number, paidAmount: number }}
 */
export function computeProportionalDiscounts(includedSum, allItemsSum, discounts) {
  if (discounts.length === 0 || allItemsSum === 0) {
    return { proportionalDiscounts: [], discountsSum: 0, paidAmount: includedSum };
  }

  const ratio = includedSum / allItemsSum;
  const proportionalDiscounts = discounts.map((discount) => ({
    description: discount.description,
    amount: Math.round(discount.amount * ratio * 100) / 100,
  }));
  const discountsSum = computeDiscountsTotal(proportionalDiscounts);
  const paidAmount = Math.round((includedSum - discountsSum) * 100) / 100;
  return { proportionalDiscounts, discountsSum, paidAmount };
}

/**
 * @param {import("./input.js").PurchaseRegistrationInput} input
 * @returns {PreparedPurchaseRegistration}
 */
export function preparePurchaseRegistration(input) {
  const allItems = input.items;
  const includedItems = allItems.filter((item) => item.included !== false);
  const includedItemsTotal = computeItemsTotal(includedItems);
  const allItemsTotal = computeItemsTotal(allItems);
  const receiptDiscounts = input.discounts ?? [];
  const receiptDiscountsTotal = computeDiscountsTotal(receiptDiscounts);

  /** @type {string | null} */
  let receiptValidation = null;
  const receiptTotal = input.receiptTotal ?? null;
  if (receiptTotal !== null && receiptTotal > 0) {
    const expected = Math.round((allItemsTotal - receiptDiscountsTotal) * 100) / 100;
    if (Math.abs(expected - receiptTotal) > 1.0) {
      receiptValidation = `⚠️ Validacion recibo: items (€${allItemsTotal.toFixed(2)}) - descuentos (€${receiptDiscountsTotal.toFixed(2)}) = €${expected.toFixed(2)}, pero el total del recibo es €${receiptTotal.toFixed(2)}.\n`;
    }
  }

  const {
    proportionalDiscounts,
    discountsSum: proportionalDiscountsTotal,
    paidAmount,
  } = computeProportionalDiscounts(includedItemsTotal, allItemsTotal, receiptDiscounts);

  return {
    storeName: input.storeName ?? null,
    purchaseDate: input.purchaseDate ?? null,
    ledgerName: input.ledgerName || "General",
    allItems,
    includedItems,
    allItemsTotal,
    includedItemsTotal,
    receiptTotal,
    receiptDiscounts,
    receiptDiscountsTotal,
    proportionalDiscounts,
    proportionalDiscountsTotal,
    paidAmount,
    receiptValidation,
  };
}
