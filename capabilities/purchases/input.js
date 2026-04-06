/**
 * @typedef {{
 *   item_name: string,
 *   quantity: number,
 *   unit_price: number,
 *   subtotal: number,
 *   included?: boolean,
 * }} PurchaseItemInput
 */

/**
 * @typedef {{
 *   description: string,
 *   amount: number,
 * }} PurchaseDiscountInput
 */

/**
 * @typedef {{
 *   storeName?: string | null,
 *   purchaseDate?: string | null,
 *   ledgerName?: string | null,
 *   receiptTotal?: number | null,
 *   items: PurchaseItemInput[],
 *   discounts?: PurchaseDiscountInput[],
 * }} PurchaseRegistrationInput
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function readString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function readFiniteNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string | null}
 */
function readOptionalString(value, fieldName) {
  if (value == null || value === "") {
    return null;
  }
  return readString(value, fieldName);
}

/**
 * @param {unknown} value
 * @returns {value is PurchaseItemInput}
 */
export function isPurchaseItemInput(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.item_name !== "string" || value.item_name.trim().length === 0) {
    return false;
  }
  if (typeof value.quantity !== "number" || !Number.isFinite(value.quantity)) {
    return false;
  }
  if (typeof value.unit_price !== "number" || !Number.isFinite(value.unit_price)) {
    return false;
  }
  if (typeof value.subtotal !== "number" || !Number.isFinite(value.subtotal)) {
    return false;
  }
  return value.included === undefined || typeof value.included === "boolean";
}

/**
 * @param {unknown} value
 * @returns {value is PurchaseDiscountInput}
 */
export function isPurchaseDiscountInput(value) {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.description === "string"
    && value.description.trim().length > 0
    && typeof value.amount === "number"
    && Number.isFinite(value.amount);
}

/**
 * @param {string} source
 * @returns {PurchaseItemInput[]}
 */
export function parsePurchaseItemsJson(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Could not parse items JSON. Provide a valid JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Items must be a JSON array.");
  }
  if (!parsed.every(isPurchaseItemInput)) {
    throw new Error("Each item must include item_name, quantity, unit_price, subtotal, and optional included.");
  }
  return parsed;
}

/**
 * @param {string} source
 * @returns {PurchaseDiscountInput[]}
 */
export function parsePurchaseDiscountsJson(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Could not parse discounts JSON. Provide a valid JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Discounts must be a JSON array.");
  }
  if (!parsed.every(isPurchaseDiscountInput)) {
    throw new Error("Each discount must include description and amount.");
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {PurchaseRegistrationInput}
 */
export function readPurchaseRegistrationInput(value) {
  if (!isRecord(value)) {
    throw new Error("Purchase input must be an object.");
  }
  const { items, discounts } = value;
  if (!Array.isArray(items) || !items.every(isPurchaseItemInput)) {
    throw new Error("Purchase input must include an items array with valid receipt items.");
  }
  if (discounts !== undefined && (!Array.isArray(discounts) || !discounts.every(isPurchaseDiscountInput))) {
    throw new Error("discounts must be an array of {description, amount} entries.");
  }

  return {
    storeName: readOptionalString(value.storeName, "storeName"),
    purchaseDate: readOptionalString(value.purchaseDate, "purchaseDate"),
    ledgerName: readOptionalString(value.ledgerName, "ledgerName"),
    receiptTotal: value.receiptTotal == null ? null : readFiniteNumber(value.receiptTotal, "receiptTotal"),
    items,
    discounts: discounts ?? [],
  };
}
