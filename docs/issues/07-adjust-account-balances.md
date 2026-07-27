# 07 — Adjust Account balances

**What to build:** Let a user establish or reconcile an Account balance with an Adjustment without
misclassifying the difference as Income or Expense.

**Blocked by:** 05 — Record Income and Expenses.

**Status:** ready-for-agent

- [ ] A user can record a signed Adjustment against one active Account.
- [ ] A user can request a target balance and fin calculates the necessary Adjustment.
- [ ] An Adjustment affects the Account balance immediately.
- [ ] An Adjustment does not affect Income, Expense, or Category totals.
- [ ] An Adjustment cannot receive a Category Assignment.
- [ ] The result states the previous balance, Adjustment amount, and resulting balance.
- [ ] Recording an Adjustment and its Change Record is one atomic operation.
- [ ] Tests cover positive and negative Adjustments on Asset and Liability Accounts.
