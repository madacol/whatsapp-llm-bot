---
name: track-purchases
description: Work with the shared purchase-ledger capability through the repo CLI instead of going through the action adapter.
---

# track-purchases

Use this skill when you need the purchases capability outside the action system and you have an explicit database target.

The shared CLI is:

```bash
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" <command> --chat-id "<chat-id>"
```

If you do not know the chat id but you do know the action database directory, use:

```bash
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" <command> --db-path "<path>"
```

For receipt registration:

1. Write a JSON file with:
   `storeName`, `purchaseDate`, `ledgerName`, `receiptTotal`, `items`, and optional `discounts`.
2. Each `items` entry must include `item_name`, `quantity`, `unit_price`, `subtotal`, and optional `included`.
3. Pass the full receipt item list. Use `included: false` for excluded items so proportional discounts stay correct.
4. Preview first, then re-run with `--yes` to persist.

Examples:

```bash
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" register --chat-id "<chat-id>" --input-file ./receipt.json
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" register --chat-id "<chat-id>" --input-file ./receipt.json --yes
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" history --chat-id "<chat-id>" --ledger-name "Groceries"
node "$(git rev-parse --show-toplevel)/scripts/track-purchases.js" summary --chat-id "<chat-id>"
```
