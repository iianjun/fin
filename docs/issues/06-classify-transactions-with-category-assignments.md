# 06 — Classify Transactions with Category Assignments

**What to build:** Let a user classify all or part of an Income or Expense with explicit or
Agent-inferred Categories and inspect the uncategorized remainder.

**Blocked by:** 04 — Manage the Category hierarchy; 05 — Record Income and Expenses.

**Status:** ready-for-agent

- [ ] A user can assign any active Category level to an Income or Expense.
- [ ] One Transaction can be split across multiple Categories.
- [ ] Category Assignments may cover the full amount or leave a signed uncategorized remainder.
- [ ] Assignment totals cannot pass the Transaction amount.
- [ ] Assignment signs and currencies follow the classified Transaction.
- [ ] Transfers and Adjustments cannot receive Category Assignments.
- [ ] Every Category Assignment records whether it was explicit or inferred.
- [ ] An inferred Assignment result states its full Category path and assigned amount.
- [ ] Category Assignment changes are included in the Transaction's atomic Change Record.
- [ ] Tests cover full, partial, split, inferred, explicit, positive, negative, and invalid
      Assignments.
