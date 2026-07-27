# 05 — Record Income and Expenses

**What to build:** Let a user record and inspect basic Income and Expense Transactions and
immediately see the resulting Account balance.

**Blocked by:** 02 — Create Accounts and configure defaults.

**Status:** ready-for-agent

- [ ] A user can record positive Income against one active Account.
- [ ] A user can record positive Expense against one active Account.
- [ ] A Transaction records a calendar date and may include a concise optional memo.
- [ ] A recorded Transaction affects the Account balance immediately.
- [ ] Asset and Liability Accounts apply Income and Expense with the correct balance direction.
- [ ] A user can list and inspect recorded Transactions with their material values.
- [ ] Recording a Transaction and its Change Record is one atomic operation.
- [ ] MCP responses state the applied Account, date, kind, amount, and memo.
- [ ] Tests verify user-visible Transaction and balance behavior through the core operation seam.
