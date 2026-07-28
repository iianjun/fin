# Product behavior

The rules in this document define the initial product behavior agreed before designing the
persistence schema.

## Vaults and accounts

- A vault starts without accounts or categories.
- A vault may designate separate default accounts for income and expense.
- Account names are unique within a vault, including archived accounts.
- Every account is either an asset or a liability and uses exactly one currency.
- Currency and account nature cannot change after the first transaction.
- Account balances are derived from transactions rather than edited directly.
- Balances and net worth are reported separately by currency. fin does not perform cross-currency
  valuation.
- An account can be archived only when its balance is zero. Archived accounts remain in history
  but cannot be used for new transactions.

## Transactions

- Income, expense, and adjustment each affect exactly one account.
- A transfer affects exactly two different accounts and stores the actual amount sent and
  received. These amounts may use different currencies.
- A transfer between accounts using the same currency sends and receives the same amount.
- A transaction has a calendar date, not a financial time of day, and takes effect immediately
  when recorded.
- A transaction may have an optional memo extracted from the descriptive part of the user's input.
- Natural-language spending queries may match both category paths and memo text.
- A refund is a negative expense. It may reference its original expense, but the reference is
  optional and removing the original does not remove the refund.
- Transfers and adjustments do not use categories.
- An activity that contains different transaction kinds is represented by related transactions.
  For example, a transfer fee is an expense related to a transfer.
- Related transactions are never edited or deleted as an implicit cascade. The agent identifies
  related records and asks whether the user wants to change them together.
- Adjustment amounts are balance deltas. When the user supplies a target balance, fin calculates
  the delta and reports the previous balance, adjustment, and resulting balance.

## Categories

- Category names are unique among siblings but may repeat under different parents.
- A category at any of the three levels may be assigned.
- The same category may classify income and expense; the category itself does not determine the
  transaction kind.
- Renaming or moving a category changes its path for past and future transactions.
- An archived category remains attached to existing transactions but cannot receive new
  assignments.
- A category assignment can cover all or part of an income or expense. The total assigned amount
  cannot exceed the transaction amount; the remainder stays uncategorized.
- A category assignment records whether the user explicitly selected it or the agent inferred it.
- The agent may infer an existing category only when the choice is unambiguous and must disclose
  the full category path and assigned amount.
- The agent may propose a new category but creates it only after user confirmation.

## Agent interaction

- A missing transaction date defaults to the current local date and is disclosed in the result.
- A missing account uses the corresponding default income or expense account when available. The
  agent asks when no applicable default exists.
- The agent asks instead of guessing when more than one account, category, or transaction kind is
  plausible.
- Every mutation response states the values actually applied, including the account, date,
  transaction kind, amount, category path, and memo when applicable.
- Values inferred by the agent are identified as inferred.
- Before creating a likely duplicate, the agent reports the matching date, account, kind, amount,
  and memo and asks for confirmation. Confirmed duplicates are allowed.
- When a requested Vault is missing, the Agent-facing error identifies `initialize_vault` with the
  same path as the recovery action and identifies the original tool call to retry afterward.
- When initialization targets an existing fin Vault, the Agent-facing error identifies
  `open_vault` as the recovery action. Initialization never overwrites an existing non-fin
  database.
- Agent-facing domain errors provide a stable code and structured recovery metadata. Integrity and
  system failures prohibit automatic retry or initialization and direct the Agent to involve the
  user.

## Change history

- Change records cover vault settings, accounts, categories, and transactions.
- They store structured changes and are rendered as natural-language descriptions for the user.
- Change records are immutable and retained for the lifetime of the vault.
- Deleting a transaction removes it from active data immediately. Its deletion record retains
  enough structured data to create a new equivalent transaction later; this is recreation, not
  restoration of the original identity.
- Change records do not identify a user, agent, or system actor. Category assignments separately
  retain whether their classification was explicit or inferred.

## Initial scope

The initial product does not include:

- bank or card integrations and file imports;
- scheduled or recurring transactions;
- budgets;
- attachments;
- tags;
- pending transactions;
- cross-currency valuation;
- specialized investment behavior; or
- structured merchants or counterparties.
