# Database schema

Each vault owns one SQLite database as decided in
[ADR 0002](adr/0002-store-each-vault-in-sqlite.md). The executable initial migration is
[`packages/core/migrations/0001_initial.sql`](../packages/core/migrations/0001_initial.sql).

## Migrations

Migration files live in `packages/core/migrations/` and use a positive numeric version followed by
a lowercase underscore-separated name, such as `0001_initial.sql`. They are applied in ascending
numeric order.

Each migration wraps its schema changes and its `schema_migrations` version insert in one
transaction. The Vault lifecycle runner skips recorded versions and rejects a migration that does
not record its own version before committing.

## Tables

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Records applied schema versions. |
| `vault_settings` | Stores the optional default income and expense accounts. |
| `accounts` | Stores asset and liability accounts in one currency each. |
| `transactions` | Stores income, expenses, transfers, and adjustments. |
| `categories` | Stores the user-defined category hierarchy. |
| `category_assignments` | Allocates income or expense amounts to categories. |
| `transaction_relations` | Links refunds to expenses and fees to transfers. |
| `change_records` | Stores immutable structured change history. |

A vault does not need a `vaults` table or repeated `vault_id` columns because the database file is
the vault boundary.

## Transaction shape

Income, expense, and adjustment use `account_id` and `amount_minor`. Transfer uses the explicit
source and destination fields:

```text
source_account_id
source_amount_minor
destination_account_id
destination_amount_minor
```

This keeps the agreed user model direct: a transfer is exactly two account endpoints, not a
separate user-facing movement abstraction. Same-currency transfers require equal source and
destination amounts. Cross-currency transfers store the actual amount on each side, allowing an
exchange rate to be derived without storing a quoted rate.

An expense amount is positive for spending and negative for a refund. Income is positive.
Adjustment is a signed change to the account's displayed balance.

## Money

All monetary values use signed SQLite integers in the account currency's minor unit. For example,
`12.34 USD` is stored as `1234`, while `12,000 KRW` is stored as `12000`. Application code must use
integer-safe arithmetic and must never pass floating-point monetary values to SQLite.

Category assignment amounts use the same sign and currency as their transaction. Assignments may
cover part of a transaction, but their sum cannot pass the transaction amount. The
`transaction_uncategorized_amounts` view exposes the signed remainder.

## Balances

`account_balance_effects` is an internal query view that converts each transaction into its effect
on an account balance. It is not a product-level `Movement` entity. `account_balances` sums these
effects and is the source for displayed balances.

The balance rules are:

| Transaction | Asset account | Liability account |
| --- | ---: | ---: |
| Income | `+amount` | `-amount` |
| Expense | `-amount` | `+amount` |
| Adjustment | `amount` | `amount` |
| Transfer source | `-source amount` | `+source amount` |
| Transfer destination | `+destination amount` | `-destination amount` |

This makes a card purchase increase card debt once. Paying the card transfers value from an asset
account to the liability account, reducing both the bank balance and card debt without creating a
second expense.

## Categories

Categories use a self-reference through `parent_id`. Database constraints and triggers enforce:

- no more than three hierarchy levels;
- no cycles;
- names unique among siblings, including root siblings;
- no new child or assignment under an archived category; and
- no assignment to transfers or adjustments.

`category_paths` exposes the current full path. Renaming or moving a category therefore changes
the path used for both historical and new transactions.

## Relations and deletion

`transaction_relations` supports:

- `refund_of`: a negative expense optionally related to a positive expense; and
- `fee_for`: a positive expense related to a transfer.

Deleting either endpoint deletes only the relation row. It never cascades to the other
transaction. Deleting a transaction does remove its own category assignments.

When deletion is allowed, the row is hard-deleted rather than soft-deleted. Core behavior must
write the corresponding structured `change_records` row in the same SQLite transaction before
deleting an account, category, or transaction. Change records themselves cannot be updated or
deleted.

## Database and core responsibilities

SQLite enforces structural invariants such as transaction shape, active Account use, category
depth, assignment totals, valid relations, immutable account identity, zero-balance archival, and
immutable change records.

Core behavior remains responsible for:

- resolving omitted dates and default accounts;
- asking before ambiguous inference or likely duplicates;
- requiring confirmation before creating an agent-proposed category;
- calculating a target-balance adjustment;
- writing each mutation and its change record atomically;
- extracting a concise memo from natural-language input; and
- rendering detailed mutation confirmations and change records in natural language.
