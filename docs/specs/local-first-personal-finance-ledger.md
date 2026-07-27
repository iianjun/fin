# Local-first personal finance ledger

## Problem Statement

People who want to understand their personal finances must usually adapt their behavior to rigid
forms, bank-specific applications, or cloud services. They need a private, local system that lets
them record and inspect financial activity in natural language while still maintaining correct
account balances, useful classifications, and an understandable history of every change.

A plain income-and-expense list is not sufficient. It cannot distinguish spending from transfers,
avoid counting credit-card payments twice, represent refunds correctly, track multiple asset and
liability Accounts, split one purchase across Categories, or explain what an Agent inferred when it
acted on an incomplete request.

## Solution

fin provides one independently movable local Vault for one person or purpose. The user manages
Asset Accounts, Liability Accounts, Transactions, Categories, and Change Records through natural
language. The core product behavior remains independent of MCP, while an MCP adapter translates
tool calls into core operations.

The user can record Income, Expenses, Transfers, and Adjustments. Account balances are derived from
Transactions, so a credit-card purchase is counted as an Expense when it happens and the later
card payment is a Transfer that reduces both an Asset Account and a Liability Account. Categories
are optional, user-defined, hierarchical, and splittable. The Agent may infer values only when the
choice is unambiguous and always reports exactly what it recorded.

Each Vault stores its current data, settings, and immutable Change Records in its own SQLite
database. Current records remain simple to query, while structured Change Records can be rendered
in natural language and retain enough information to recreate a deleted Transaction as a new
Transaction.

## User Stories

1. As a personal finance user, I want my financial data stored locally, so that I retain control of
   my private information.
2. As a personal finance user, I want each Vault to be an independent folder, so that I can copy,
   back up, or move one financial context without affecting another.
3. As a personal finance user, I want a new Vault to start empty, so that it does not impose an
   irrelevant Account or Category structure on me.
4. As a personal finance user, I want multiple Accounts in one Vault, so that I can track money and
   debt held in different places.
5. As a personal finance user, I want to give every Account a distinct name, so that natural
   language references identify one Account without ambiguity.
6. As a personal finance user, I want Asset Accounts for cash and bank balances, so that fin can
   track money I own.
7. As a personal finance user, I want Liability Accounts for credit cards and loans, so that fin
   can track money I owe.
8. As a personal finance user, I want each Account to use one currency, so that every amount has an
   exact monetary meaning.
9. As a personal finance user, I want balances reported separately by currency, so that fin does
   not present a misleading total based on an unspecified exchange rate.
10. As a personal finance user, I want optional default Income and Expense Accounts, so that common
    entries remain concise.
11. As a personal finance user, I want fin to ask which Account to use when no applicable default
    exists, so that it does not guess incorrectly.
12. As a personal finance user, I want Account balances derived from Transactions, so that editing
    or deleting a Transaction updates the balance consistently.
13. As a personal finance user, I want to correct an Account balance with an Adjustment, so that I
    can start from a known balance or reconcile a discrepancy without inventing Income or Expense.
14. As a personal finance user, I want a target-balance request converted into the necessary
    Adjustment, so that I do not have to calculate the difference myself.
15. As a personal finance user, I want an Account archived only when its balance is zero, so that
    archiving cannot hide money or debt.
16. As a personal finance user, I want archived Accounts retained in historical Transactions, so
    that old records remain understandable.
17. As a personal finance user, I want archived Accounts excluded from new Transactions and default
    Account selection, so that closed Accounts are not reused accidentally.
18. As a personal finance user, I want Account currency and asset-or-liability nature fixed after
    the first Transaction, so that past amounts never change meaning.
19. As a personal finance user, I want to record Income on a calendar date, so that I can inspect
    when value entered my Vault.
20. As a personal finance user, I want to record an Expense on a calendar date, so that I can
    inspect when value left my Vault.
21. As a personal finance user, I want a Transaction to take effect immediately, so that balances
    and reports reflect what I just recorded.
22. As a personal finance user, I want a missing Transaction date to default to today, so that
    common natural-language entries stay brief.
23. As a personal finance user, I want the Agent to disclose when it defaulted a date to today, so
    that I can verify the recorded result.
24. As a personal finance user, I want an optional concise memo extracted from my description, so
    that later natural-language searches can find concepts such as coffee or a meeting.
25. As a personal finance user, I want spending queries to consider Category paths and memo text,
    so that I can ask questions using the words I naturally remember.
26. As a personal finance user, I want a Transfer represented as one Transaction between exactly
    two Accounts, so that moving my own money is not counted as Income or Expense.
27. As a personal finance user, I want same-currency Transfers to move the same amount on both
    sides, so that money cannot appear or disappear silently.
28. As a personal finance user, I want cross-currency Transfers to store the actual amount sent and
    received, so that the effective exchange rate can be derived from the real transaction.
29. As a credit-card user, I want a card purchase to increase card debt and record one Expense, so
    that my spending is recognized on the purchase date.
30. As a credit-card user, I want paying my card from a bank Account recorded as a Transfer, so that
    paying the bill does not duplicate the original Expense.
31. As a personal finance user, I want a transfer fee recorded as a related Expense, so that it
    remains distinct from the value moved between Accounts.
32. As a personal finance user, I want related Transactions changed or deleted only after explicit
    confirmation, so that a request affecting one record does not silently cascade to another.
33. As a personal finance user, I want a refund represented as a negative Expense, so that it
    reduces spending instead of inflating Income.
34. As a personal finance user, I want a Refund optionally related to its original Expense, so that
    I can trace full and partial refunds when the original is known.
35. As a personal finance user, I want a Refund to remain valid when its original Expense is
    missing or deleted, so that imported or incomplete history does not invalidate real money.
36. As a personal finance user, I want to create my own Category hierarchy, so that classification
    reflects how I think about my finances.
37. As a personal finance user, I want up to three Category levels, so that I can use broad,
    intermediate, and specific classifications without an unusably deep tree.
38. As a personal finance user, I want to assign any Category level, so that I can classify a
    Transaction as precisely as the available information allows.
39. As a personal finance user, I want Category names unique among siblings but reusable under
    different parents, so that paths remain unambiguous without banning useful names such as
    “Other.”
40. As a personal finance user, I want the same Category usable for Income and Expense, so that
    reimbursements and spending can be analyzed under one economic purpose.
41. As a personal finance user, I want Category use to be optional, so that incomplete information
    never prevents me from recording a Transaction.
42. As a personal finance user, I want one Transaction split across multiple Categories, so that a
    mixed purchase can be classified accurately.
43. As a personal finance user, I want partial Category Assignment, so that known portions can be
    classified while the remainder stays uncategorized.
44. As a personal finance user, I want Category Assignment totals prevented from exceeding the
    Transaction amount, so that classification cannot create impossible totals.
45. As a personal finance user, I want renamed or moved Categories reflected in past and future
    reports, so that I maintain one current classification system.
46. As a personal finance user, I want archived Categories retained on old Transactions but blocked
    from new assignments, so that historical reports remain intact without cluttering current
    classification.
47. As a personal finance user, I want to state a Category explicitly, so that the Agent uses my
    chosen classification.
48. As a personal finance user, I want the Agent to infer an existing Category only when the choice
    is unambiguous, so that convenient automation does not become silent misclassification.
49. As a personal finance user, I want every Category Assignment marked as explicit or inferred, so
    that I can distinguish my choices from Agent decisions.
50. As a personal finance user, I want an inferred Category reported with its full path and assigned
    amount, so that I can immediately verify the Agent's decision.
51. As a personal finance user, I want the Agent to request confirmation before creating a new
    Category, so that my hierarchy does not fill with near-duplicates.
52. As a personal finance user, I want the Agent to ask when more than one Account, Category, or
    Transaction kind is plausible, so that ambiguity is resolved by me rather than hidden.
53. As a personal finance user, I want every mutation response to state the Account, date,
    Transaction kind, amount, Category path, and memo that were applied, so that “added” is never an
    insufficient confirmation.
54. As a personal finance user, I want all inferred values identified as inferred, so that the
    Agent's assumptions remain visible.
55. As a personal finance user, I want fin to detect a likely duplicate before recording it, so that
    repeated requests do not silently duplicate my finances.
56. As a personal finance user, I want to confirm a legitimate duplicate, so that two genuinely
    identical purchases can both be recorded.
57. As a personal finance user, I want every major data mutation represented by a Change Record, so
    that I can ask what changed.
58. As a personal finance user, I want Change Records rendered as natural-language descriptions, so
    that the history is understandable without reading database structures.
59. As a personal finance user, I want Change Records stored as structured facts, so that they can
    be searched and rendered reliably.
60. As a personal finance user, I want Change Records immutable and retained for the Vault's
    lifetime, so that the history cannot be silently rewritten.
61. As a personal finance user, I want a deleted Transaction removed from active balances and
    reports immediately, so that deleted data no longer affects current finances.
62. As a personal finance user, I want deletion history to retain enough data to create an
    equivalent new Transaction later, so that natural-language “recovery” remains possible.
63. As a personal finance user, I want recreated data to receive a new identity, so that history
    remains honest about deletion and recreation.

## Implementation Decisions

- The core module owns all reusable product behavior, domain validation, persistence operations,
  balance calculations, ambiguity handling inputs, and mutation result contracts.
- The MCP module is a thin stdio adapter. It may depend on core, while core must not depend on MCP
  protocol, SDK, or transport concepts.
- Each Vault owns one SQLite database. There is no shared database, Vault table, or repeated Vault
  identifier on domain tables.
- A new Vault contains one settings record but no seeded Accounts or Categories.
- The persistence schema contains schema migrations, Vault settings, Accounts, Transactions,
  Categories, Category Assignments, Transaction relations, and Change Records.
- SQLite foreign keys, strict tables, checks, indexes, triggers, and query views enforce structural
  integrity at the persistence boundary.
- Account names are unique within a Vault, including archived Accounts.
- Every Account has an asset-or-liability nature and one three-letter currency code. Nature and
  currency become immutable after the first Transaction.
- Optional default Income and Expense Accounts are Vault settings. An archived Account cannot
  remain or become a default.
- Account balances are derived from Transaction effects rather than stored as authoritative mutable
  values.
- Income, Expense, and Adjustment use one Account and one signed minor-unit amount. Income is
  positive, ordinary Expense is positive, Refund is negative Expense, and Adjustment is a signed
  balance delta.
- Transfer uses explicit source Account, source amount, destination Account, and destination amount
  fields in the Transaction model. No product-level Movement entity is introduced.
- Transfer endpoints must be different. Equal amounts are required when both Accounts use the same
  currency; different actual amounts are retained when currencies differ.
- Monetary values are stored as integers in the Account currency's minor unit. Floating-point money
  is not accepted at the persistence boundary.
- Transaction dates are calendar dates. System timestamps remain available for creation, updates,
  and Change Records but are not the financial date.
- Transaction relations support Refund-to-Expense and fee-to-Transfer links. Removing a relation
  endpoint removes the link, not the other Transaction.
- Categories use a self-referencing parent relationship with a maximum depth of three and cycle
  prevention.
- Category names are unique among siblings. Root Categories follow the same sibling uniqueness
  rule.
- Category Assignments belong only to Income or Expense, use the same sign and currency as the
  Transaction, and record explicit or inferred origin.
- Multiple Category Assignments may cover a Transaction partially or completely, but their sum
  cannot pass the Transaction amount.
- Category paths and Account balances are exposed as derived query results rather than separately
  maintained authoritative data.
- Active domain records are updated in place. When deletion is allowed, the current row is
  hard-deleted rather than soft-deleted.
- Mutations and their structured Change Records must be written atomically in one SQLite
  transaction.
- Change Records cover Vault settings, Accounts, Categories, and Transactions. Their payloads are
  structured JSON objects, and Change Records cannot be updated or individually deleted.
- Change Records do not store an actor. Category Assignment origin separately records explicit or
  inferred classification.
- Core operations must return the complete applied result needed for detailed natural-language
  confirmation rather than a generic success flag.
- Date defaulting, default Account selection, memo extraction, ambiguity detection, inferred
  Category disclosure, new Category confirmation, and likely-duplicate confirmation are core
  behavior exposed through the MCP adapter.
- The database rejects structural violations. The core module remains responsible for
  conversational decisions that depend on user intent.

## Testing Decisions

- Use one primary, high-level persistence seam: apply the complete migration to a fresh in-memory
  SQLite database, perform realistic domain operations through the persistence contract, and
  inspect externally observable records, balances, and rejected invalid operations.
- Tests should describe user-visible financial behavior rather than individual SQL statements,
  trigger names, helper functions, or internal query construction.
- Existing schema-level tests are the prior art. They already exercise the complete migration and
  validate behavior through real SQLite execution rather than mocks.
- Verify that a new Vault starts without Accounts or Categories and has usable settings.
- Verify that a credit-card purchase creates one Expense, increases liability, and that card
  payment is a Transfer that does not duplicate spending.
- Verify asset, liability, Income, Expense, Refund, Adjustment, Transfer source, and Transfer
  destination balance effects.
- Verify same-currency Transfer equality and cross-currency retention of actual source and
  destination amounts.
- Verify Account name uniqueness, identity immutability after the first Transaction, zero-balance
  archival, archived Account restrictions, and default Account restrictions.
- Verify Transaction shape, date validity, distinct Transfer endpoints, signed monetary values, and
  immediate balance effects.
- Verify three-level Category depth, cycle prevention, sibling uniqueness, current-path behavior,
  archival restrictions, and assignment restrictions.
- Verify full, partial, explicit, inferred, positive, and negative Category Assignments, including
  overflow rejection and uncategorized remainder.
- Verify valid and invalid Refund and fee relations, including deletion of one endpoint without
  deletion of the other Transaction.
- Verify structured Change Record payload validity, immutability, retention behavior, and
  transactionally paired mutation expectations.
- Verify likely-duplicate detection and ambiguity handling at the future public core-operation seam,
  because those behaviors depend on intent and should not be encoded as database uniqueness.
- Verify detailed mutation results at the future public core-operation seam, including disclosure of
  defaulted and inferred values.
- MCP tests should focus only on protocol mapping once MCP tools exist. They should not repeat core
  finance and persistence behavior.
- Repository verification must include formatting, linting, type checking, the full test suite, and
  the build before handoff.

## Out of Scope

- Bank and card provider integrations.
- CSV, statement, or other file imports.
- Scheduled or recurring Transactions.
- Budgets and budget rollover behavior.
- Attachments and receipt storage.
- Tags.
- Pending or posted Transaction states.
- Live exchange rates and cross-currency net-worth valuation.
- Specialized securities, positions, cost basis, dividends, or other investment behavior.
- Structured merchants, payees, or counterparties.
- Automatic creation of a new Category without user confirmation.
- Automatic cascading edits or deletion across related Transactions.
- A shared server database or synchronization between Vaults.
- User, Agent, or system actor attribution on Change Records.
- MCP protocol details inside the core module.

## Further Notes

- This specification consolidates the agreed MVP behavior. The domain glossary remains the
  canonical source for product terminology, and the architecture decisions remain authoritative
  for module boundaries, per-Vault SQLite storage, and the separation of active data from Change
  Records.
- The current executable schema and schema-level tests establish the persistence foundation. The
  next implementation seam is a public core persistence API that performs domain mutations and
  writes Change Records atomically; MCP tools should be built only after that core contract exists.
- “Recovery” of a deleted Transaction means creating a new Transaction from structured deletion
  history. It does not restore the deleted identity.
- Natural-language confirmation is part of correctness. A successful mutation is not complete
  until the user can see the material values that were applied and which values were inferred.
