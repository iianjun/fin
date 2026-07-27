# 10 — Edit, delete, and recreate Transactions

**What to build:** Let a user correct or remove a Transaction, inspect the immutable history of the
change, and create a new equivalent Transaction from deletion history when needed.

**Blocked by:** 06 — Classify Transactions with Category Assignments; 07 — Adjust Account balances;
08 — Transfer value between Accounts; 09 — Relate Refunds and transfer fees.

**Status:** ready-for-agent

- [ ] A user can edit the material values of each Transaction kind while preserving all invariants.
- [ ] Editing immediately updates Account balances, reports, Category Assignments, and relations.
- [ ] A user can delete a Transaction from active data without leaving it in current balances or
      reports.
- [ ] Edit and delete operations write immutable structured Change Records atomically.
- [ ] A user can query Change Records as complete natural-language descriptions.
- [ ] Deletion history retains enough structured data to create an equivalent new Transaction.
- [ ] Recreation produces a new Transaction identity and a new Change Record.
- [ ] Related Transactions are identified before an edit or delete and never changed implicitly.
- [ ] Tests cover editing, deletion, history rendering, and recreation for every Transaction shape.
