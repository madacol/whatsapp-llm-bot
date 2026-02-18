export default /** @type {defineAction} */ ((x) => x)({
  name: "track_purchases",
  command: "compras",
  description: "Gestiona un registro de compras. Puede: 1) Extraer items de una foto de factura y guardarlos, 2) Mostrar el historial de compras, 3) Mostrar un resumen/total de gastos. Envía una foto de factura para registrarla o pide ver el historial.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Acción a realizar: 'extract' para extraer de foto, 'history' para ver historial, 'summary' para resumen de gastos, 'delete' para borrar un registro por ID",
        enum: ["extract", "history", "summary", "delete"]
      },
      purchase_id: {
        type: "string",
        description: "ID de la compra a eliminar (solo para action=delete)"
      }
    },
    required: ["action"]
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useChatDb: true,
    useLlm: true
  },
  action_fn: async function (context, params) {
    const { chatDb, callLlm, content, log } = context;

    await chatDb.sql`
      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        store_name TEXT,
        purchase_date TEXT,
        total NUMERIC(12,2),
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await chatDb.sql`
      CREATE TABLE IF NOT EXISTS purchase_items (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
        item_name TEXT,
        quantity NUMERIC(10,2) DEFAULT 1,
        unit_price NUMERIC(12,2),
        subtotal NUMERIC(12,2)
      )
    `;

    if (params.action === "extract") {
      const image = content.find(c => c.type === "image");
      if (!image) {
        return "No encontre ninguna foto de factura. Por favor envia una imagen de la factura junto con el comando.";
      }

      await log("Analizando factura...");

      // Build prompt in OpenAI vision format (array of content parts)
      const prompt = [
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mime_type || "image/jpeg"};base64,${image.data}`
          }
        },
        {
          type: "text",
          text: `Analiza esta imagen de una factura/recibo de compra. Extrae la siguiente informacion en formato JSON estricto (sin markdown, solo JSON puro):
{
  "store_name": "nombre de la tienda/comercio",
  "purchase_date": "fecha de compra (formato YYYY-MM-DD, o null si no se ve)",
  "items": [
    {
      "item_name": "nombre del producto",
      "quantity": 1,
      "unit_price": 0.00,
      "subtotal": 0.00
    }
  ],
  "total": 0.00
}

IMPORTANTE:
- Los precios deben ser numeros sin simbolos de moneda
- Si no puedes leer algun campo, pon null
- Extrae TODOS los items visibles
- El total debe ser el monto total de la factura (lo que realmente se pago, despues de descuentos)
- Responde SOLO con el JSON, nada mas`
        }
      ];

      const llmResponse = await callLlm(prompt);
      if (!llmResponse) {
        return "No pude analizar la factura. Intenta con una foto mas clara.";
      }

      await log("Respuesta LLM: " + llmResponse.substring(0, 200));

      let data;
      try {
        const cleaned = llmResponse.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        data = JSON.parse(cleaned);
      } catch (e) {
        await log("Error parsing LLM response: " + llmResponse);
        return "No pude interpretar los datos de la factura. Intenta con una foto mas clara.";
      }

      const { rows } = await chatDb.sql`
        INSERT INTO purchases (store_name, purchase_date, total, notes)
        VALUES (${data.store_name || "Desconocido"}, ${data.purchase_date}, ${data.total || 0}, ${""})
        RETURNING id
      `;
      const purchaseId = rows[0].id;

      if (data.items && data.items.length > 0) {
        for (const item of data.items) {
          await chatDb.sql`
            INSERT INTO purchase_items (purchase_id, item_name, quantity, unit_price, subtotal)
            VALUES (${purchaseId}, ${item.item_name}, ${item.quantity || 1}, ${item.unit_price || 0}, ${item.subtotal || 0})
          `;
        }
      }

      let result = `*Factura registrada* (ID: ${purchaseId})\n\n`;
      result += `*Tienda:* ${data.store_name || "No identificada"}\n`;
      result += `*Fecha:* ${data.purchase_date || "No identificada"}\n\n`;
      result += `*Items:*\n`;

      if (data.items && data.items.length > 0) {
        data.items.forEach((item, i) => {
          const price = item.subtotal || item.unit_price || 0;
          result += `  ${i + 1}. ${item.item_name} — x${item.quantity || 1} — €${Number(price).toFixed(2)}\n`;
        });
      }

      result += `\n*Total: €${Number(data.total || 0).toFixed(2)}*`;
      return result;

    } else if (params.action === "history") {
      const { rows: purchases } = await chatDb.sql`
        SELECT * FROM purchases ORDER BY created_at DESC LIMIT 20
      `;

      if (purchases.length === 0) {
        return "No tienes compras registradas aun. Enviame una foto de una factura para empezar.";
      }

      let result = "*Historial de Compras*\n\n";
      for (const p of purchases) {
        const { rows: items } = await chatDb.sql`
          SELECT * FROM purchase_items WHERE purchase_id = ${p.id}
        `;
        result += `*#${p.id}* — ${p.store_name || "?"} — ${p.purchase_date || "Sin fecha"}\n`;
        items.forEach(item => {
          result += `  • ${item.item_name} x${item.quantity} — €${Number(item.subtotal).toFixed(2)}\n`;
        });
        result += `  *Total: €${Number(p.total).toFixed(2)}*\n\n`;
      }
      return result;

    } else if (params.action === "summary") {
      const { rows: summary } = await chatDb.sql`
        SELECT 
          COUNT(*) as total_purchases,
          COALESCE(SUM(total), 0) as total_spent
        FROM purchases
      `;
      const { rows: byStore } = await chatDb.sql`
        SELECT 
          store_name,
          COUNT(*) as visits,
          SUM(total) as spent
        FROM purchases
        GROUP BY store_name
        ORDER BY spent DESC
        LIMIT 10
      `;
      const { rows: topItems } = await chatDb.sql`
        SELECT 
          item_name,
          SUM(quantity) as total_qty,
          SUM(subtotal) as total_spent
        FROM purchase_items
        GROUP BY item_name
        ORDER BY total_spent DESC
        LIMIT 10
      `;

      const s = summary[0];
      let result = "*Resumen de Gastos*\n\n";
      result += `*Total compras:* ${s.total_purchases}\n`;
      result += `*Total gastado:* €${Number(s.total_spent).toFixed(2)}\n\n`;

      if (byStore.length > 0) {
        result += `*Por tienda:*\n`;
        byStore.forEach(store => {
          result += `  • ${store.store_name || "?"}: ${store.visits} visitas — €${Number(store.spent).toFixed(2)}\n`;
        });
        result += "\n";
      }

      if (topItems.length > 0) {
        result += `*Top productos (por gasto):*\n`;
        topItems.forEach((item, i) => {
          result += `  ${i + 1}. ${item.item_name} — x${Number(item.total_qty)} — €${Number(item.total_spent).toFixed(2)}\n`;
        });
      }

      return result;

    } else if (params.action === "delete") {
      if (!params.purchase_id) {
        return "Necesito el ID de la compra a eliminar. Usa !compras para ver el historial.";
      }
      const { rows } = await chatDb.sql`
        DELETE FROM purchases WHERE id = ${params.purchase_id} RETURNING id, store_name
      `;
      if (rows.length === 0) {
        return `No se encontro la compra con ID ${params.purchase_id}`;
      }
      return `Compra #${rows[0].id} (${rows[0].store_name}) eliminada correctamente.`;
    }

    return "Accion no reconocida. Usa: extract, history, summary o delete.";
  }
});
