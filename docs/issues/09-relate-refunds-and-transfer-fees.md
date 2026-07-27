# 09 — Relate Refunds and transfer fees

**What to build:** Let a user represent Refunds and transfer fees with their correct financial
meaning while keeping each related Transaction independently controllable.

**Blocked by:** 05 — Record Income and Expenses; 08 — Transfer value between Accounts.

**Status:** complete

- [x] A user can record a Refund as a negative Expense.
- [x] A Refund reduces Expense totals and reverses the Account balance effect correctly.
- [x] A Refund may reference one positive original Expense but remains valid without that link.
- [x] Deleting an original Expense removes the relation but leaves its Refund active.
- [x] A user can record a transfer fee as a positive Expense related to a Transfer.
- [x] Editing or deleting one related Transaction never silently mutates the other.
- [x] An operation that finds related Transactions returns them and requires explicit confirmation
      before applying a multi-Transaction change.
- [x] Relation mutations are represented in atomic Transaction Change Records.
- [x] Tests cover full and partial Refunds, missing originals, transfer fees, and non-cascading
      behavior.
