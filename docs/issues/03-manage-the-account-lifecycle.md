# 03 — Manage the Account lifecycle

**What to build:** Let a user maintain Account identity and archive closed Accounts without hiding
money, invalidating history, or reusing an inactive Account accidentally.

**Blocked by:** 02 — Create Accounts and configure defaults.

**Status:** complete

- [x] A user can rename an Account while preserving its identity and historical references.
- [x] Account names remain unique across active and archived Accounts.
- [x] Currency and asset-or-liability nature may change only before the first Transaction.
- [x] Archiving is rejected while the Account balance is nonzero.
- [x] Archiving is rejected while the Account is configured as a default.
- [x] An archived Account remains visible in historical reads but cannot receive new Transactions.
- [x] A user can reactivate an archived Account.
- [x] Every lifecycle mutation writes an atomic Change Record and returns a detailed result.
- [x] Tests verify lifecycle behavior through the public core operation seam.
