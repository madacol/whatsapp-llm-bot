
/**
 * Ensure the purchases schema exists (with ledger support).
 * @param {PGlite} db
 */
export async function ensureSchema(db) {
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
export async function getOrCreateLedger(db, name) {
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
export function computeItemsTotal(items) {
  const sum = items.reduce((acc, item) => acc + (item.subtotal || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Sum all discount amounts, rounded to 2 decimals.
 * @param {Array<{amount: number}>} discounts
 * @returns {number}
 */
export function computeDiscountsTotal(discounts) {
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
export function computeProportionalDiscounts(includedSum, allItemsSum, discounts) {
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
export function formatPreview(data, ledgerName) {
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


export default /** @type {defineAction} */ ((x) => x)({
  name: "track_purchases",
  command: "compras",
  optIn: true,
  description: "Register purchase data and manage purchase history. To process a receipt/invoice image: first call extract_from_image to extract the data, then call this with action='register' passing ALL receipt items (with included=true/false flags), ALL discounts, and total (amount paid). The action computes proportional discounts for included items automatically using the full item list. Also use for: purchase history ('history'), spending summary ('summary'), deleting a purchase ('delete'), and ledger management ('list_ledgers', 'rename_ledger', 'delete_ledger').",
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
        description: "JSON array of EVERY item from the receipt extraction. Each item: {item_name, quantity, unit_price, subtotal, included: true/false}. IMPORTANT: you MUST pass ALL items from the extraction — mark included=true for items the user wants to register, included=false for the rest. The full list is required to compute proportional discounts correctly."
      },
      discounts: {
        type: "string",
        description: "JSON array of ALL discounts from the receipt, each with {description, amount}. Include employee discounts, vouchers, coupons, etc."
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
  formatToolCall: ({ action, store_name, ledger_name }) => {
    if (action === "register") return `Registering purchase${store_name ? ` from ${store_name}` : ""}`;
    if (action === "history") return `Showing purchase history${ledger_name ? ` (${ledger_name})` : ""}`;
    if (action === "summary") return `Showing spending summary${ledger_name ? ` (${ledger_name})` : ""}`;
    if (action === "delete") return "Deleting purchase";
    if (action === "list_ledgers") return "Listing ledgers";
    if (action === "rename_ledger") return `Renaming ledger: ${ledger_name ?? ""}`;
    if (action === "delete_ledger") return `Deleting ledger: ${ledger_name ?? ""}`;
    return `Purchases: ${action}`;
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (context, params) {
    const { db, confirm } = context;

    await ensureSchema(db);

    if (params.action === "register") {
      if (!params.items) {
        return "Missing items. Provide a JSON array of items with {item_name, quantity, unit_price, subtotal}.";
      }

      /** @type {Array<{item_name: string, quantity: number, unit_price: number, subtotal: number, included?: boolean}>} */
      let allItems;
      try {
        allItems = JSON.parse(params.items);
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

      const includedItems = allItems.filter(i => i.included !== false);
      const includedSum = computeItemsTotal(includedItems);
      const allItemsSum = computeItemsTotal(allItems);

      // Validate receipt integrity
      /** @type {string | null} */
      let receiptValidation = null;
      const receiptTotal = Number(params.total || 0);
      const discountsSum = computeDiscountsTotal(discounts);
      if (receiptTotal > 0) {
        const expected = Math.round((allItemsSum - discountsSum) * 100) / 100;
        if (Math.abs(expected - receiptTotal) > 1.0) {
          receiptValidation = `⚠️ Validacion recibo: items (€${allItemsSum.toFixed(2)}) - descuentos (€${discountsSum.toFixed(2)}) = €${expected.toFixed(2)}, pero el total del recibo es €${receiptTotal.toFixed(2)}.\n`;
        }
      }

      // Compute proportional discounts for included items
      const { proportionalDiscounts, discountsSum: propDiscountsSum, paidAmount } =
        computeProportionalDiscounts(includedSum, allItemsSum, discounts);

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
