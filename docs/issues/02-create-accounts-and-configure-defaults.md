# 02 — Create Accounts and configure defaults

**What to build:** Let a user create Asset and Liability Accounts, inspect them, and select the
default Accounts used for common Income and Expense entries.

**Blocked by:** 01 — Initialize and open a Vault.

**Status:** complete

- [x] A user can create an Asset Account or Liability Account with a unique name and one currency.
- [x] Creating a duplicate Account name is rejected with an actionable result.
- [x] A user can list Accounts with their nature, currency, archive state, and current balance.
- [x] A user can select or clear separate default Income and Expense Accounts.
- [x] An archived Account cannot be selected as a default.
- [x] Account and default-setting mutations write immutable Change Records atomically.
- [x] MCP mutation responses state the Account values and settings that were actually applied.
- [x] Tests cover the complete Account creation and default-setting behavior without mocking
      SQLite.
