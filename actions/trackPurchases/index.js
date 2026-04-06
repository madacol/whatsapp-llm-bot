import {
  parsePurchaseDiscountsJson,
  parsePurchaseItemsJson,
} from "../../capabilities/purchases/input.js";
import {
  computeItemsTotal,
  preparePurchaseRegistration,
} from "../../capabilities/purchases/math.js";
import {
  formatDeletedLedgerResult,
  formatDeletedPurchaseResult,
  formatDeleteLedgerPreview,
  formatLedgerList,
  formatPurchaseHistory,
  formatPurchasePreview,
  formatPurchaseSummary,
  formatRegisteredPurchaseResult,
  formatRenamedLedgerResult,
} from "../../capabilities/purchases/presentation.js";
import {
  deleteLedgerById,
  deletePurchaseById,
  ensurePurchasesSchema,
  getPurchaseHistory,
  getPurchaseSummary,
  listPurchaseLedgers,
  prepareLedgerDeletion,
  registerPreparedPurchase,
  renamePurchaseLedger,
} from "../../capabilities/purchases/store.js";

export { getOrCreateLedger } from "../../capabilities/purchases/store.js";
export { computeItemsTotal, computeDiscountsTotal, computeProportionalDiscounts } from "../../capabilities/purchases/math.js";

/**
 * Backwards-compatible export for existing action tests.
 * @param {import("../../capabilities/purchases/math.js").PreparedPurchaseRegistration | {
 *   store_name?: string | null,
 *   purchase_date?: string | null,
 *   includedItems?: Array<{ item_name: string, quantity: number, unit_price: number, subtotal: number }>,
 *   proportionalDiscounts?: Array<{ description: string, amount: number }>,
 *   discountsSum?: number,
 *   paidAmount?: number,
 *   receiptValidation?: string | null,
 * }} prepared
 * @param {string} ledgerName
 * @returns {string}
 */
export function formatPreview(prepared, ledgerName) {
  if ("includedItemsTotal" in prepared && "proportionalDiscountsTotal" in prepared) {
    return formatPurchasePreview(prepared, ledgerName);
  }

  const includedItems = prepared.includedItems ?? [];
  return formatPurchasePreview({
    storeName: prepared.store_name ?? null,
    purchaseDate: prepared.purchase_date ?? null,
    ledgerName,
    allItems: includedItems,
    includedItems,
    allItemsTotal: computeItemsTotal(includedItems),
    includedItemsTotal: computeItemsTotal(includedItems),
    receiptTotal: null,
    receiptDiscounts: [],
    receiptDiscountsTotal: 0,
    proportionalDiscounts: prepared.proportionalDiscounts ?? [],
    proportionalDiscountsTotal: prepared.discountsSum ?? 0,
    paidAmount: prepared.paidAmount ?? 0,
    receiptValidation: prepared.receiptValidation ?? null,
  }, ledgerName);
}

/**
 * Backwards-compatible export for existing action tests.
 * @param {import("@electric-sql/pglite").PGlite | import("@electric-sql/pglite").Transaction} db
 * @returns {Promise<void>}
 */
export async function ensureSchema(db) {
  await ensurePurchasesSchema(db);
}

/**
 * @param {number | undefined} total
 * @returns {number | null}
 */
function readReceiptTotal(total) {
  if (total == null) {
    return null;
  }
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error("total must be a finite number.");
  }
  return total;
}

/**
 * @param {string | undefined} purchaseId
 * @returns {number | null}
 */
function readPurchaseId(purchaseId) {
  if (!purchaseId) {
    return null;
  }
  const parsed = Number(purchaseId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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

    await ensurePurchasesSchema(db);

    if (params.action === "register") {
      if (!params.items) {
        return "Missing items. Provide a JSON array of items with {item_name, quantity, unit_price, subtotal}.";
      }

      let items;
      try {
        items = parsePurchaseItemsJson(params.items);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }

      /** @type {import("../../capabilities/purchases/input.js").PurchaseDiscountInput[]} */
      let discounts = [];
      if (params.discounts) {
        try {
          discounts = parsePurchaseDiscountsJson(params.discounts);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }

      let receiptTotal;
      try {
        receiptTotal = readReceiptTotal(params.total);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }

      const prepared = preparePurchaseRegistration({
        storeName: params.store_name || null,
        purchaseDate: params.purchase_date || null,
        ledgerName: params.ledger_name || "General",
        receiptTotal,
        items,
        discounts,
      });

      const preview = formatPurchasePreview(prepared, prepared.ledgerName);
      const confirmed = await confirm(preview);
      if (!confirmed) {
        return { result: "Registro cancelado.", autoContinue: false };
      }

      const saved = await registerPreparedPurchase(db, prepared);
      return formatRegisteredPurchaseResult(
        { purchaseId: saved.purchaseId, ledgerName: saved.ledger.name },
        prepared,
      );
    }

    if (params.action === "history") {
      return formatPurchaseHistory(await getPurchaseHistory(db, { ledgerName: params.ledger_name }));
    }

    if (params.action === "summary") {
      return formatPurchaseSummary(await getPurchaseSummary(db, { ledgerName: params.ledger_name }));
    }

    if (params.action === "delete") {
      const purchaseId = readPurchaseId(params.purchase_id);
      if (purchaseId === null) {
        return "Necesito el ID de la compra a eliminar. Usa !compras para ver el historial.";
      }
      const deleted = await deletePurchaseById(db, purchaseId);
      if (!deleted.found) {
        return `No se encontro la compra con ID ${params.purchase_id}`;
      }
      return formatDeletedPurchaseResult(deleted.purchaseId, deleted.storeName || "?");
    }

    if (params.action === "list_ledgers") {
      return formatLedgerList(await listPurchaseLedgers(db));
    }

    if (params.action === "rename_ledger") {
      if (!params.ledger_name) {
        return "Necesito el nombre del libro a renombrar (ledger_name).";
      }
      if (!params.new_ledger_name) {
        return "Necesito el nuevo nombre para el libro (new_ledger_name).";
      }
      const renamed = await renamePurchaseLedger(db, params.ledger_name, params.new_ledger_name);
      if (!renamed.found || !renamed.ledger) {
        return `No se encontro el libro "${params.ledger_name}".`;
      }
      return formatRenamedLedgerResult(renamed.ledger.name);
    }

    if (params.action === "delete_ledger") {
      if (!params.ledger_name) {
        return "Necesito el nombre del libro a eliminar (ledger_name).";
      }

      const deletion = await prepareLedgerDeletion(db, params.ledger_name);
      if (!deletion.found || deletion.ledgerId === null || deletion.ledgerName === null) {
        return `No se encontro el libro "${params.ledger_name}".`;
      }

      const confirmed = await confirm(formatDeleteLedgerPreview(deletion.ledgerName, deletion.purchaseCount));
      if (!confirmed) {
        return { result: "Eliminacion cancelada.", autoContinue: false };
      }

      await deleteLedgerById(db, deletion.ledgerId);
      return formatDeletedLedgerResult(deletion.ledgerName, deletion.purchaseCount);
    }

    return "Accion no reconocida. Usa: register, history, summary, delete, list_ledgers, rename_ledger o delete_ledger.";
  }
});
