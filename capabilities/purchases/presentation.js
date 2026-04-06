/**
 * Format a receipt preview for confirmation.
 * @param {import("./math.js").PreparedPurchaseRegistration} prepared
 * @param {string} ledgerName
 * @returns {string}
 */
export function formatPurchasePreview(prepared, ledgerName) {
  let preview = `*Vista previa de factura*\n`;
  preview += `*Libro:* ${ledgerName}\n`;
  preview += `*Tienda:* ${prepared.storeName || "No identificada"}\n`;
  preview += `*Fecha:* ${prepared.purchaseDate || "No identificada"}\n\n`;
  preview += `*Items:*\n`;
  for (const [index, item] of prepared.includedItems.entries()) {
    const price = item.subtotal || item.unit_price;
    preview += `  ${index + 1}. ${item.item_name} — x${item.quantity} — €${Number(price).toFixed(2)}\n`;
  }

  preview += `\n*Suma items: €${prepared.includedItemsTotal.toFixed(2)}*\n`;
  if (prepared.proportionalDiscounts.length > 0) {
    preview += `*Descuentos (proporcional):*\n`;
    for (const discount of prepared.proportionalDiscounts) {
      preview += `  • ${discount.description} — -€${Number(discount.amount).toFixed(2)}\n`;
    }
    preview += `*Total descuentos: -€${prepared.proportionalDiscountsTotal.toFixed(2)}*\n`;
  }

  preview += `*Total pagado: €${prepared.paidAmount.toFixed(2)}*\n`;
  if (prepared.receiptValidation) {
    preview += prepared.receiptValidation;
  }
  preview += `\nReact 👍 para guardar o 👎 para cancelar.`;
  return preview;
}

/**
 * @param {{ purchaseId: number, ledgerName: string }} saved
 * @param {import("./math.js").PreparedPurchaseRegistration} prepared
 * @returns {string}
 */
export function formatRegisteredPurchaseResult(saved, prepared) {
  let result = `*Factura registrada* (ID: ${saved.purchaseId}) — Libro: ${saved.ledgerName}\n\n`;
  result += `*Tienda:* ${prepared.storeName || "No identificada"}\n`;
  result += `*Fecha:* ${prepared.purchaseDate || "No identificada"}\n\n`;
  result += `*Items:*\n`;

  for (const [index, item] of prepared.includedItems.entries()) {
    const price = item.subtotal || item.unit_price;
    result += `  ${index + 1}. ${item.item_name} — x${item.quantity} — €${Number(price).toFixed(2)}\n`;
  }

  result += `\n*Subtotal: €${prepared.includedItemsTotal.toFixed(2)}*\n`;
  if (prepared.proportionalDiscounts.length > 0) {
    for (const discount of prepared.proportionalDiscounts) {
      result += `*${discount.description}: -€${Number(discount.amount).toFixed(2)}*\n`;
    }
    result += `*Total descuentos: -€${prepared.proportionalDiscountsTotal.toFixed(2)}*\n`;
  }
  result += `*Total pagado: €${prepared.paidAmount.toFixed(2)}*`;
  return result;
}

/**
 * @param {import("./store.js").PurchaseHistoryResult} history
 * @returns {string}
 */
export function formatPurchaseHistory(history) {
  if (!history.found && history.ledgerName) {
    return `No se encontro el libro "${history.ledgerName}".`;
  }
  if (history.purchases.length === 0) {
    return history.ledgerName
      ? `No tienes compras en el libro "${history.ledgerName}".`
      : "No tienes compras registradas aun. Enviame una foto de una factura para empezar.";
  }

  let result = history.ledgerName
    ? `*Historial de Compras — ${history.ledgerName}*\n\n`
    : "*Historial de Compras*\n\n";

  for (const purchase of history.purchases) {
    const prefix = history.ledgerName ? `*#${purchase.id}*` : `*#${purchase.id}* [${purchase.ledgerName}]`;
    result += `${prefix} — ${purchase.storeName || "?"} — ${purchase.purchaseDate || "Sin fecha"}\n`;
    for (const item of purchase.items) {
      result += `  • ${item.item_name} x${item.quantity} — €${Number(item.subtotal).toFixed(2)}\n`;
    }
    for (const discount of purchase.discounts) {
      result += `  🏷️ ${discount.description} — -€${Number(discount.amount).toFixed(2)}\n`;
    }
    result += `  *Total: €${Number(purchase.total).toFixed(2)}*\n\n`;
  }

  return result;
}

/**
 * @param {import("./store.js").PurchaseSummaryResult} summary
 * @returns {string}
 */
export function formatPurchaseSummary(summary) {
  if (!summary.found && summary.ledgerName) {
    return `No se encontro el libro "${summary.ledgerName}".`;
  }

  let result = summary.ledgerName
    ? `*Resumen de Gastos — ${summary.ledgerName}*\n\n`
    : "*Resumen de Gastos*\n\n";
  result += `*Total compras:* ${summary.totalPurchases}\n`;
  result += `*Total gastado:* €${Number(summary.totalSpent).toFixed(2)}\n\n`;

  if (summary.byLedger.length > 0) {
    result += `*Por libro:*\n`;
    for (const ledger of summary.byLedger) {
      result += `  • ${ledger.ledgerName}: ${ledger.count} compras — €${Number(ledger.totalSpent).toFixed(2)}\n`;
    }
    result += "\n";
  }

  if (summary.byStore.length > 0) {
    result += `*Por tienda:*\n`;
    for (const store of summary.byStore) {
      result += `  • ${store.storeName || "?"}: ${store.visits} visitas — €${Number(store.totalSpent).toFixed(2)}\n`;
    }
    result += "\n";
  }

  if (summary.topItems.length > 0) {
    result += `*Top productos (por gasto):*\n`;
    for (const [index, item] of summary.topItems.entries()) {
      result += `  ${index + 1}. ${item.itemName} — x${Number(item.totalQuantity)} — €${Number(item.totalSpent).toFixed(2)}\n`;
    }
  }

  return result;
}

/**
 * @param {number} purchaseId
 * @param {string | null} storeName
 * @returns {string}
 */
export function formatDeletedPurchaseResult(purchaseId, storeName) {
  return `Compra #${purchaseId} (${storeName}) eliminada correctamente.`;
}

/**
 * @param {import("./store.js").PurchaseLedgerStats[]} ledgers
 * @returns {string}
 */
export function formatLedgerList(ledgers) {
  if (ledgers.length === 0) {
    return "No hay libros de compras creados aun.";
  }

  let result = "*Libros de Compras*\n\n";
  for (const ledger of ledgers) {
    result += `• *${ledger.name}* — ${ledger.purchaseCount} compras — €${Number(ledger.totalSpent).toFixed(2)}\n`;
  }
  return result;
}

/**
 * @param {string} ledgerName
 * @returns {string}
 */
export function formatRenamedLedgerResult(ledgerName) {
  return `Libro renombrado a "${ledgerName}".`;
}

/**
 * @param {string} ledgerName
 * @param {number} purchaseCount
 * @returns {string}
 */
export function formatDeleteLedgerPreview(ledgerName, purchaseCount) {
  return `⚠️ *Eliminar libro "${ledgerName}"*\n\n`
    + `Se eliminaran ${purchaseCount} compra(s) asociadas.\n\n`
    + `React 👍 para confirmar o 👎 para cancelar.`;
}

/**
 * @param {string} ledgerName
 * @param {number} purchaseCount
 * @returns {string}
 */
export function formatDeletedLedgerResult(ledgerName, purchaseCount) {
  return `Libro "${ledgerName}" eliminado con ${purchaseCount} compra(s).`;
}
