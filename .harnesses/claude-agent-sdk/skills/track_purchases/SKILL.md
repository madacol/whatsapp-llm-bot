# Track Purchases

Register purchase data and manage purchase history using a PGlite database.

## Database

The purchase tracking database is at `./pgdata/CHAT_ID/track_purchases/`.
Use the `psql` command or direct SQL queries via Bash to interact with it.

**Note:** PGlite databases are embedded PostgreSQL — use standard PostgreSQL SQL syntax. The database runs as a file-based embedded DB, not a server. You cannot connect to it via `psql`. Instead, write a small Node.js script using `@electric-sql/pglite` to execute queries:

```js
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite("./pgdata/CHAT_ID/track_purchases/");
const { rows } = await db.query("SELECT * FROM purchases ORDER BY created_at DESC LIMIT 20");
console.log(JSON.stringify(rows, null, 2));
await db.close();
```

## Schema

### Tables

- **ledgers** — Purchase ledger groupings
  - `id` SERIAL PRIMARY KEY
  - `name` TEXT NOT NULL UNIQUE
  - `created_at` TIMESTAMP

- **purchases** — Individual purchase records
  - `id` SERIAL PRIMARY KEY
  - `ledger_id` INTEGER REFERENCES ledgers(id) ON DELETE CASCADE
  - `store_name` TEXT
  - `purchase_date` TEXT
  - `total` NUMERIC(12,2)
  - `notes` TEXT
  - `created_at` TIMESTAMP

- **purchase_items** — Line items within a purchase
  - `id` SERIAL PRIMARY KEY
  - `purchase_id` INTEGER REFERENCES purchases(id) ON DELETE CASCADE
  - `item_name` TEXT
  - `quantity` NUMERIC(10,2) DEFAULT 1
  - `unit_price` NUMERIC(12,2)
  - `subtotal` NUMERIC(12,2)

- **purchase_discounts** — Discounts applied to a purchase
  - `id` SERIAL PRIMARY KEY
  - `purchase_id` INTEGER REFERENCES purchases(id) ON DELETE CASCADE
  - `description` TEXT
  - `amount` NUMERIC(12,2)

## Operations

### Register a purchase
1. Extract items from a receipt image (use vision/OCR)
2. Create the tables if they don't exist (run the CREATE TABLE IF NOT EXISTS statements)
3. Get or create a ledger by name
4. Insert the purchase, items, and discounts in a transaction
5. Compute proportional discounts when only some items are included

### View history
Query purchases with their items and discounts, ordered by created_at DESC.

### View summary
Aggregate totals by store, by ledger, and top items by spending.

### Delete a purchase
DELETE FROM purchases WHERE id = $1 (cascades to items and discounts).

### Manage ledgers
- List: SELECT with purchase counts and totals
- Rename: UPDATE ledgers SET name = $1 WHERE LOWER(name) = LOWER($2)
- Delete: DELETE FROM ledgers WHERE id = $1 (cascades to purchases)

## Language

This skill's user-facing output should be in Spanish (the user's preference for this feature).
Currency is EUR (€).
