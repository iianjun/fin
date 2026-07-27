# 11 — Query balances and spending

**What to build:** Let a user answer practical financial questions by Account, date, Transaction
kind, Category path, and memo while keeping currencies separate.

**Blocked by:** 06 — Classify Transactions with Category Assignments; 07 — Adjust Account balances;
08 — Transfer value between Accounts; 09 — Relate Refunds and transfer fees.

**Status:** complete

- [x] A user can inspect every active Account balance and archive state.
- [x] Balance and net-worth results remain separated by currency.
- [x] A user can filter Transactions by date range, Account, and Transaction kind.
- [x] A user can total Income and Expense without counting Transfers or Adjustments.
- [x] Refunds reduce Expense totals rather than increasing Income.
- [x] A user can aggregate spending through current Category paths, including child rollups.
- [x] A user can find and total Transactions from memo text such as “coffee.”
- [x] Query results identify uncategorized amounts instead of inventing a fallback Category.
- [x] MCP query results contain enough structured evidence for the Agent to explain the answer.
- [x] Tests verify totals, filters, Category rollups, memo matching, Refunds, and multi-currency
      separation.
