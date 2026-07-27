# 05 — Record Income and Expenses

**What to build:** Let a user record and inspect basic Income and Expense Transactions and
immediately see the resulting Account balance.

**Blocked by:** 02 — Create Accounts and configure defaults.

**Status:** complete

- [x] A user can record positive Income against one active Account.
- [x] A user can record positive Expense against one active Account.
- [x] A Transaction records a calendar date and may include a concise optional memo.
- [x] A recorded Transaction affects the Account balance immediately.
- [x] Asset and Liability Accounts apply Income and Expense with the correct balance direction.
- [x] A user can list and inspect recorded Transactions with their material values.
- [x] Recording a Transaction and its Change Record is one atomic operation.
- [x] MCP responses state the applied Account, date, kind, amount, and memo.
- [x] Tests verify user-visible Transaction and balance behavior through the core operation seam.
