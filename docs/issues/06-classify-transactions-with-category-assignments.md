# 06 — Classify Transactions with Category Assignments

**What to build:** Let a user classify all or part of an Income or Expense with explicit or
Agent-inferred Categories and inspect the uncategorized remainder.

**Blocked by:** 04 — Manage the Category hierarchy; 05 — Record Income and Expenses.

**Status:** complete

- [x] A user can assign any active Category level to an Income or Expense.
- [x] One Transaction can be split across multiple Categories.
- [x] Category Assignments may cover the full amount or leave a signed uncategorized remainder.
- [x] Assignment totals cannot pass the Transaction amount.
- [x] Assignment signs and currencies follow the classified Transaction.
- [x] Transfers and Adjustments cannot receive Category Assignments.
- [x] Every Category Assignment records whether it was explicit or inferred.
- [x] An inferred Assignment result states its full Category path and assigned amount.
- [x] Category Assignment changes are included in the Transaction's atomic Change Record.
- [x] Tests cover full, partial, split, inferred, explicit, positive, negative, and invalid
      Assignments.
