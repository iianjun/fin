# 11 — Query balances and spending

**What to build:** Let a user answer practical financial questions by Account, date, Transaction
kind, Category path, and memo while keeping currencies separate.

**Blocked by:** 06 — Classify Transactions with Category Assignments; 07 — Adjust Account balances;
08 — Transfer value between Accounts; 09 — Relate Refunds and transfer fees.

**Status:** ready-for-agent

- [ ] A user can inspect every active Account balance and archive state.
- [ ] Balance and net-worth results remain separated by currency.
- [ ] A user can filter Transactions by date range, Account, and Transaction kind.
- [ ] A user can total Income and Expense without counting Transfers or Adjustments.
- [ ] Refunds reduce Expense totals rather than increasing Income.
- [ ] A user can aggregate spending through current Category paths, including child rollups.
- [ ] A user can find and total Transactions from memo text such as “coffee.”
- [ ] Query results identify uncategorized amounts instead of inventing a fallback Category.
- [ ] MCP query results contain enough structured evidence for the Agent to explain the answer.
- [ ] Tests verify totals, filters, Category rollups, memo matching, Refunds, and multi-currency
      separation.
