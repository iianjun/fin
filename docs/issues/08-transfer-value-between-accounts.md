# 08 — Transfer value between Accounts

**What to build:** Let a user move value between two Accounts, including card payments and
cross-currency Transfers, without creating false Income or Expense.

**Blocked by:** 05 — Record Income and Expenses.

**Status:** ready-for-agent

- [ ] A user can record one Transfer between two different active Accounts.
- [ ] A same-currency Transfer requires equal source and destination amounts.
- [ ] A cross-currency Transfer stores the actual source and destination amounts independently.
- [ ] Transfer balance effects are correct for Asset-to-Asset, Asset-to-Liability,
      Liability-to-Asset, and Liability-to-Liability combinations.
- [ ] Paying a credit card reduces the bank Asset Account and card Liability Account without
      recording another Expense.
- [ ] A Transfer does not affect Income, Expense, or Category totals.
- [ ] Recording a Transfer and its Change Record is one atomic operation.
- [ ] MCP responses identify both Accounts, both amounts, both currencies, and the date.
- [ ] Tests verify same-currency, cross-currency, and credit-card payment scenarios.
