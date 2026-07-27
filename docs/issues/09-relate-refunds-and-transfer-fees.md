# 09 — Relate Refunds and transfer fees

**What to build:** Let a user represent Refunds and transfer fees with their correct financial
meaning while keeping each related Transaction independently controllable.

**Blocked by:** 05 — Record Income and Expenses; 08 — Transfer value between Accounts.

**Status:** ready-for-agent

- [ ] A user can record a Refund as a negative Expense.
- [ ] A Refund reduces Expense totals and reverses the Account balance effect correctly.
- [ ] A Refund may reference one positive original Expense but remains valid without that link.
- [ ] Deleting an original Expense removes the relation but leaves its Refund active.
- [ ] A user can record a transfer fee as a positive Expense related to a Transfer.
- [ ] Editing or deleting one related Transaction never silently mutates the other.
- [ ] An operation that finds related Transactions returns them and requires explicit confirmation
      before applying a multi-Transaction change.
- [ ] Relation mutations are represented in atomic Transaction Change Records.
- [ ] Tests cover full and partial Refunds, missing originals, transfer fees, and non-cascading
      behavior.
