# 07 — Adjust Account balances

**What to build:** Let a user establish or reconcile an Account balance with an Adjustment without
misclassifying the difference as Income or Expense.

**Blocked by:** 05 — Record Income and Expenses.

**Status:** complete

- [x] A user can record a signed Adjustment against one active Account.
- [x] A user can request a target balance and fin calculates the necessary Adjustment.
- [x] An Adjustment affects the Account balance immediately.
- [x] An Adjustment does not affect Income, Expense, or Category totals.
- [x] An Adjustment cannot receive a Category Assignment.
- [x] The result states the previous balance, Adjustment amount, and resulting balance.
- [x] Recording an Adjustment and its Change Record is one atomic operation.
- [x] Tests cover positive and negative Adjustments on Asset and Liability Accounts.
