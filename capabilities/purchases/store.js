/**
 * @typedef {{ id: number, name: string }} PurchaseLedger
 */

/**
 * @typedef {{ id: number, item_name: string, quantity: number, unit_price: number, subtotal: number }} StoredPurchaseItem
 */

/**
 * @typedef {{ id: number, description: string, amount: number }} StoredPurchaseDiscount
 */

/**
 * @typedef {{
 *   id: number,
 *   ledgerName: string,
 *   storeName: string | null,
 *   purchaseDate: string | null,
 *   total: number,
 *   items: StoredPurchaseItem[],
 *   discounts: StoredPurchaseDiscount[],
 * }} StoredPurchaseRecord
 */

/**
 * @typedef {{
 *   found: boolean,
 *   ledgerName: string | null,
 *   purchases: StoredPurchaseRecord[],
 * }} PurchaseHistoryResult
 */

/**
 * @typedef {{ ledgerName: string, count: number, totalSpent: number }} LedgerSpendSummary
 */

/**
 * @typedef {{ storeName: string | null, visits: number, totalSpent: number }} StoreSpendSummary
 */

/**
 * @typedef {{ itemName: string, totalQuantity: number, totalSpent: number }} TopPurchasedItem
 */

/**
 * @typedef {{
 *   found: boolean,
 *   ledgerName: string | null,
 *   totalPurchases: number,
 *   totalSpent: number,
 *   byLedger: LedgerSpendSummary[],
 *   byStore: StoreSpendSummary[],
 *   topItems: TopPurchasedItem[],
 * }} PurchaseSummaryResult
 */

/**
 * @typedef {{ id: number, name: string, purchaseCount: number, totalSpent: number }} PurchaseLedgerStats
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} row
 * @param {string} field
 * @returns {unknown}
 */
function readRowValue(row, field) {
  if (!isRecord(row) || !(field in row)) {
    throw new Error(`Missing row field "${field}".`);
  }
  return row[field];
}

/**
 * @param {unknown} row
 * @param {string} field
 * @returns {number}
 */
function readRowNumber(row, field) {
  const value = readRowValue(row, field);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Expected numeric row field "${field}".`);
}

/**
 * @param {unknown} row
 * @param {string} field
 * @returns {string}
 */
function readRowString(row, field) {
  const value = readRowValue(row, field);
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    throw new Error(`Expected string row field "${field}".`);
  }
  return String(value);
}

/**
 * @param {unknown} row
 * @param {string} field
 * @returns {string | null}
 */
function readNullableRowString(row, field) {
  const value = readRowValue(row, field);
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/**
 * @param {import("@electric-sql/pglite").PGlite | import("@electric-sql/pglite").Transaction} db
 */
export async function ensurePurchasesSchema(db) {
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
 * @param {import("@electric-sql/pglite").PGlite | import("@electric-sql/pglite").Transaction} db
 * @param {string} name
 * @returns {Promise<PurchaseLedger | null>}
 */
export async function findLedgerByName(db, name) {
  const { rows } = await db.sql`
    SELECT id, name FROM ledgers WHERE LOWER(name) = LOWER(${name})
  `;
  const [row] = rows;
  if (!row) {
    return null;
  }
  return {
    id: readRowNumber(row, "id"),
    name: readRowString(row, "name"),
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite | import("@electric-sql/pglite").Transaction} db
 * @param {string} name
 * @returns {Promise<PurchaseLedger>}
 */
export async function getOrCreateLedger(db, name) {
  const existing = await findLedgerByName(db, name);
  if (existing) {
    return existing;
  }

  const { rows } = await db.sql`
    INSERT INTO ledgers (name) VALUES (${name}) RETURNING id, name
  `;
  const [row] = rows;
  if (!row) {
    throw new Error(`Failed to create ledger "${name}".`);
  }
  return {
    id: readRowNumber(row, "id"),
    name: readRowString(row, "name"),
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {import("./math.js").PreparedPurchaseRegistration} prepared
 * @returns {Promise<{ purchaseId: number, ledger: PurchaseLedger }>}
 */
export async function registerPreparedPurchase(db, prepared) {
  const ledger = await getOrCreateLedger(db, prepared.ledgerName);

  const purchaseId = await db.transaction(async (
    /** @type {import("@electric-sql/pglite").Transaction} */ tx,
  ) => {
    const { rows } = await tx.sql`
      INSERT INTO purchases (ledger_id, store_name, purchase_date, total, notes)
      VALUES (${ledger.id}, ${prepared.storeName || "Desconocido"}, ${prepared.purchaseDate}, ${prepared.paidAmount}, ${""})
      RETURNING id
    `;
    const [purchaseRow] = rows;
    if (!purchaseRow) {
      throw new Error("Failed to insert purchase.");
    }
    const insertedPurchaseId = readRowNumber(purchaseRow, "id");

    for (const item of prepared.includedItems) {
      await tx.sql`
        INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal)
        VALUES (${insertedPurchaseId}, ${item.item_name}, ${item.quantity}, ${item.unit_price}, ${item.subtotal})
      `;
    }

    for (const discount of prepared.proportionalDiscounts) {
      await tx.sql`
        INSERT INTO purchase_discounts (purchase_id, description, amount)
        VALUES (${insertedPurchaseId}, ${discount.description}, ${discount.amount})
      `;
    }

    return insertedPurchaseId;
  });

  return { purchaseId, ledger };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {number} purchaseId
 * @returns {Promise<StoredPurchaseItem[]>}
 */
async function getItemsForPurchase(db, purchaseId) {
  const { rows } = await db.sql`
    SELECT id, item_name, quantity, unit_price, subtotal
    FROM purchase_items
    WHERE purchase_id = ${purchaseId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: readRowNumber(row, "id"),
    item_name: readRowString(row, "item_name"),
    quantity: readRowNumber(row, "quantity"),
    unit_price: readRowNumber(row, "unit_price"),
    subtotal: readRowNumber(row, "subtotal"),
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {number} purchaseId
 * @returns {Promise<StoredPurchaseDiscount[]>}
 */
async function getDiscountsForPurchase(db, purchaseId) {
  const { rows } = await db.sql`
    SELECT id, description, amount
    FROM purchase_discounts
    WHERE purchase_id = ${purchaseId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: readRowNumber(row, "id"),
    description: readRowString(row, "description"),
    amount: readRowNumber(row, "amount"),
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {{ ledgerName?: string }} [options]
 * @returns {Promise<PurchaseHistoryResult>}
 */
export async function getPurchaseHistory(db, options = {}) {
  const requestedLedgerName = options.ledgerName ?? null;
  /** @type {PurchaseLedger | null} */
  let ledger = null;
  if (requestedLedgerName) {
    ledger = await findLedgerByName(db, requestedLedgerName);
    if (!ledger) {
      return { found: false, ledgerName: requestedLedgerName, purchases: [] };
    }
  }

  const { rows } = ledger
    ? await db.sql`
        SELECT p.id, p.store_name, p.purchase_date, p.total, l.name AS ledger_name
        FROM purchases p
        JOIN ledgers l ON p.ledger_id = l.id
        WHERE p.ledger_id = ${ledger.id}
        ORDER BY p.created_at DESC
        LIMIT 20
      `
    : await db.sql`
        SELECT p.id, p.store_name, p.purchase_date, p.total, l.name AS ledger_name
        FROM purchases p
        JOIN ledgers l ON p.ledger_id = l.id
        ORDER BY p.created_at DESC
        LIMIT 20
      `;

  /** @type {StoredPurchaseRecord[]} */
  const purchases = [];
  for (const row of rows) {
    const purchaseId = readRowNumber(row, "id");
    purchases.push({
      id: purchaseId,
      ledgerName: readRowString(row, "ledger_name"),
      storeName: readNullableRowString(row, "store_name"),
      purchaseDate: readNullableRowString(row, "purchase_date"),
      total: readRowNumber(row, "total"),
      items: await getItemsForPurchase(db, purchaseId),
      discounts: await getDiscountsForPurchase(db, purchaseId),
    });
  }

  return {
    found: true,
    ledgerName: ledger ? ledger.name : null,
    purchases,
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {{ ledgerName?: string }} [options]
 * @returns {Promise<PurchaseSummaryResult>}
 */
export async function getPurchaseSummary(db, options = {}) {
  const requestedLedgerName = options.ledgerName ?? null;
  /** @type {PurchaseLedger | null} */
  let ledger = null;
  if (requestedLedgerName) {
    ledger = await findLedgerByName(db, requestedLedgerName);
    if (!ledger) {
      return {
        found: false,
        ledgerName: requestedLedgerName,
        totalPurchases: 0,
        totalSpent: 0,
        byLedger: [],
        byStore: [],
        topItems: [],
      };
    }
  }

  const { rows: summaryRows } = ledger
    ? await db.sql`
        SELECT COUNT(*) AS total_purchases, COALESCE(SUM(total), 0) AS total_spent
        FROM purchases
        WHERE ledger_id = ${ledger.id}
      `
    : await db.sql`
        SELECT COUNT(*) AS total_purchases, COALESCE(SUM(total), 0) AS total_spent
        FROM purchases
      `;
  const [summaryRow] = summaryRows;
  if (!summaryRow) {
    throw new Error("Missing summary row.");
  }

  const { rows: byStoreRows } = ledger
    ? await db.sql`
        SELECT store_name, COUNT(*) AS visits, SUM(total) AS spent
        FROM purchases
        WHERE ledger_id = ${ledger.id}
        GROUP BY store_name
        ORDER BY spent DESC
        LIMIT 10
      `
    : await db.sql`
        SELECT store_name, COUNT(*) AS visits, SUM(total) AS spent
        FROM purchases
        GROUP BY store_name
        ORDER BY spent DESC
        LIMIT 10
      `;

  const { rows: topItemRows } = ledger
    ? await db.sql`
        SELECT pi.item_name, SUM(pi.quantity) AS total_qty, SUM(pi.subtotal) AS total_spent
        FROM purchase_items pi
        JOIN purchases p ON pi.purchase_id = p.id
        WHERE p.ledger_id = ${ledger.id}
        GROUP BY pi.item_name
        ORDER BY total_spent DESC
        LIMIT 10
      `
    : await db.sql`
        SELECT item_name, SUM(quantity) AS total_qty, SUM(subtotal) AS total_spent
        FROM purchase_items
        GROUP BY item_name
        ORDER BY total_spent DESC
        LIMIT 10
      `;

  /** @type {LedgerSpendSummary[]} */
  let byLedger = [];
  if (!ledger) {
    const { rows: byLedgerRows } = await db.sql`
      SELECT l.name AS ledger_name, COUNT(*) AS count, SUM(p.total) AS spent
      FROM purchases p
      JOIN ledgers l ON p.ledger_id = l.id
      GROUP BY l.name
      ORDER BY spent DESC
    `;
    byLedger = byLedgerRows.map((row) => ({
      ledgerName: readRowString(row, "ledger_name"),
      count: readRowNumber(row, "count"),
      totalSpent: readRowNumber(row, "spent"),
    }));
  }

  return {
    found: true,
    ledgerName: ledger ? ledger.name : null,
    totalPurchases: readRowNumber(summaryRow, "total_purchases"),
    totalSpent: readRowNumber(summaryRow, "total_spent"),
    byLedger,
    byStore: byStoreRows.map((row) => ({
      storeName: readNullableRowString(row, "store_name"),
      visits: readRowNumber(row, "visits"),
      totalSpent: readRowNumber(row, "spent"),
    })),
    topItems: topItemRows.map((row) => ({
      itemName: readRowString(row, "item_name"),
      totalQuantity: readRowNumber(row, "total_qty"),
      totalSpent: readRowNumber(row, "total_spent"),
    })),
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {number} purchaseId
 * @returns {Promise<{ found: boolean, purchaseId: number, storeName: string | null }>}
 */
export async function deletePurchaseById(db, purchaseId) {
  const { rows } = await db.sql`
    DELETE FROM purchases
    WHERE id = ${purchaseId}
    RETURNING id, store_name
  `;
  const [row] = rows;
  if (!row) {
    return { found: false, purchaseId, storeName: null };
  }
  return {
    found: true,
    purchaseId: readRowNumber(row, "id"),
    storeName: readNullableRowString(row, "store_name"),
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @returns {Promise<PurchaseLedgerStats[]>}
 */
export async function listPurchaseLedgers(db) {
  const { rows } = await db.sql`
    SELECT l.id, l.name, COUNT(p.id) AS purchase_count, COALESCE(SUM(p.total), 0) AS total_spent
    FROM ledgers l
    LEFT JOIN purchases p ON p.ledger_id = l.id
    GROUP BY l.id, l.name
    ORDER BY l.name
  `;

  return rows.map((row) => ({
    id: readRowNumber(row, "id"),
    name: readRowString(row, "name"),
    purchaseCount: readRowNumber(row, "purchase_count"),
    totalSpent: readRowNumber(row, "total_spent"),
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} ledgerName
 * @param {string} newLedgerName
 * @returns {Promise<{ found: boolean, ledger: PurchaseLedger | null }>}
 */
export async function renamePurchaseLedger(db, ledgerName, newLedgerName) {
  const { rows } = await db.sql`
    UPDATE ledgers
    SET name = ${newLedgerName}
    WHERE LOWER(name) = LOWER(${ledgerName})
    RETURNING id, name
  `;
  const [row] = rows;
  if (!row) {
    return { found: false, ledger: null };
  }
  return {
    found: true,
    ledger: {
      id: readRowNumber(row, "id"),
      name: readRowString(row, "name"),
    },
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} ledgerName
 * @returns {Promise<{ found: boolean, ledgerId: number | null, ledgerName: string | null, purchaseCount: number }>}
 */
export async function prepareLedgerDeletion(db, ledgerName) {
  const ledger = await findLedgerByName(db, ledgerName);
  if (!ledger) {
    return { found: false, ledgerId: null, ledgerName, purchaseCount: 0 };
  }

  const { rows } = await db.sql`
    SELECT COUNT(*) AS count FROM purchases WHERE ledger_id = ${ledger.id}
  `;
  const [countRow] = rows;
  if (!countRow) {
    throw new Error(`Missing purchase count for ledger "${ledger.name}".`);
  }

  return {
    found: true,
    ledgerId: ledger.id,
    ledgerName: ledger.name,
    purchaseCount: readRowNumber(countRow, "count"),
  };
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {number} ledgerId
 * @returns {Promise<void>}
 */
export async function deleteLedgerById(db, ledgerId) {
  await db.sql`DELETE FROM ledgers WHERE id = ${ledgerId}`;
}
