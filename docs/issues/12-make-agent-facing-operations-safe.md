# 12 — Make Agent-facing operations safe

**What to build:** Make every Agent-facing mutation resolve defaults and clear matches
automatically while stopping for confirmation when an assumption, duplicate, or new Category
would be unsafe.

**Blocked by:** 06 — Classify Transactions with Category Assignments; 08 — Transfer value between
Accounts; 11 — Query balances and spending.

**Status:** ready-for-agent

- [ ] A missing date resolves to the current local date and the result identifies that default.
- [ ] A missing Account uses the applicable active default Income or Expense Account when one
      exists.
- [ ] More than one plausible Account, Category, or Transaction kind produces candidate results
      without mutating the Vault.
- [ ] An existing Category is inferred only when one unambiguous match exists.
- [ ] Creating an Agent-proposed Category requires explicit user confirmation.
- [ ] A likely duplicate reports the matching date, Account, kind, amount, and memo before mutation.
- [ ] A confirmed legitimate duplicate can be recorded.
- [ ] Every successful mutation returns the material values actually applied.
- [ ] Every defaulted or inferred value is marked clearly in the mutation result.
- [ ] MCP responses allow the Agent to produce detailed confirmations rather than a generic success
      message.
- [ ] Tests exercise the Agent-facing core contract for defaults, ambiguity, inference, duplicate
      confirmation, and complete mutation receipts.
