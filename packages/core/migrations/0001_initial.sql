PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  nature TEXT NOT NULL CHECK (nature IN ('asset', 'liability')),
  currency TEXT NOT NULL CHECK (
    length(currency) = 3
    AND currency = upper(currency)
    AND currency GLOB '[A-Z][A-Z][A-Z]'
  ),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX accounts_name_unique ON accounts (name COLLATE NOCASE);

CREATE TABLE vault_settings (
  singleton_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  default_income_account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  default_expense_account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO vault_settings (singleton_id) VALUES (1);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment')),
  occurred_on TEXT NOT NULL CHECK (
    occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(occurred_on) = occurred_on
  ),
  account_id INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  amount_minor INTEGER,
  source_account_id INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  source_amount_minor INTEGER,
  destination_account_id INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  destination_amount_minor INTEGER,
  memo TEXT CHECK (memo IS NULL OR length(trim(memo)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (
      kind IN ('income', 'expense', 'adjustment')
      AND account_id IS NOT NULL
      AND amount_minor IS NOT NULL
      AND amount_minor != 0
      AND source_account_id IS NULL
      AND source_amount_minor IS NULL
      AND destination_account_id IS NULL
      AND destination_amount_minor IS NULL
    )
    OR (
      kind = 'transfer'
      AND account_id IS NULL
      AND amount_minor IS NULL
      AND source_account_id IS NOT NULL
      AND source_amount_minor > 0
      AND destination_account_id IS NOT NULL
      AND destination_amount_minor > 0
      AND source_account_id != destination_account_id
    )
  ),
  CHECK (kind != 'income' OR amount_minor > 0)
) STRICT;

CREATE INDEX transactions_occurred_on_index ON transactions (occurred_on);
CREATE INDEX transactions_kind_occurred_on_index ON transactions (kind, occurred_on);
CREATE INDEX transactions_account_index ON transactions (account_id, occurred_on);
CREATE INDEX transactions_source_account_index ON transactions (source_account_id, occurred_on);
CREATE INDEX transactions_destination_account_index
  ON transactions (destination_account_id, occurred_on);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_id IS NULL OR parent_id != id)
) STRICT;

CREATE UNIQUE INDEX categories_root_name_unique
  ON categories (name COLLATE NOCASE)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX categories_child_name_unique
  ON categories (parent_id, name COLLATE NOCASE)
  WHERE parent_id IS NOT NULL;

CREATE TABLE category_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'inferred')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (transaction_id, category_id)
) STRICT;

CREATE INDEX category_assignments_category_index
  ON category_assignments (category_id, transaction_id);

CREATE TABLE transaction_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('refund_of', 'fee_for')),
  source_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  target_transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (source_transaction_id != target_transaction_id),
  UNIQUE (source_transaction_id, relation_kind)
) STRICT;

CREATE INDEX transaction_relations_target_index
  ON transaction_relations (target_transaction_id, relation_kind);

CREATE TABLE change_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('vault_settings', 'account', 'category', 'transaction')
  ),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX change_records_entity_index
  ON change_records (entity_type, entity_id, recorded_at);
CREATE INDEX change_records_recorded_at_index ON change_records (recorded_at);

CREATE VIEW account_balance_effects AS
SELECT
  transactions.id AS transaction_id,
  transactions.account_id,
  CASE transactions.kind
    WHEN 'income' THEN
      CASE accounts.nature
        WHEN 'asset' THEN transactions.amount_minor
        ELSE -transactions.amount_minor
      END
    WHEN 'expense' THEN
      CASE accounts.nature
        WHEN 'asset' THEN -transactions.amount_minor
        ELSE transactions.amount_minor
      END
    ELSE transactions.amount_minor
  END AS amount_minor
FROM transactions
JOIN accounts ON accounts.id = transactions.account_id
WHERE transactions.kind IN ('income', 'expense', 'adjustment')

UNION ALL

SELECT
  transactions.id AS transaction_id,
  transactions.source_account_id AS account_id,
  CASE accounts.nature
    WHEN 'asset' THEN -transactions.source_amount_minor
    ELSE transactions.source_amount_minor
  END AS amount_minor
FROM transactions
JOIN accounts ON accounts.id = transactions.source_account_id
WHERE transactions.kind = 'transfer'

UNION ALL

SELECT
  transactions.id AS transaction_id,
  transactions.destination_account_id AS account_id,
  CASE accounts.nature
    WHEN 'asset' THEN transactions.destination_amount_minor
    ELSE -transactions.destination_amount_minor
  END AS amount_minor
FROM transactions
JOIN accounts ON accounts.id = transactions.destination_account_id
WHERE transactions.kind = 'transfer';

CREATE VIEW account_balances AS
SELECT
  accounts.id AS account_id,
  accounts.currency,
  COALESCE(sum(account_balance_effects.amount_minor), 0) AS balance_minor
FROM accounts
LEFT JOIN account_balance_effects ON account_balance_effects.account_id = accounts.id
GROUP BY accounts.id, accounts.currency;

CREATE VIEW category_paths AS
WITH RECURSIVE paths (id, parent_id, name, depth, path, archived_at) AS (
  SELECT id, parent_id, name, 1, name, archived_at
  FROM categories
  WHERE parent_id IS NULL

  UNION ALL

  SELECT
    categories.id,
    categories.parent_id,
    categories.name,
    paths.depth + 1,
    paths.path || ' > ' || categories.name,
    categories.archived_at
  FROM categories
  JOIN paths ON paths.id = categories.parent_id
)
SELECT id, parent_id, name, depth, path, archived_at
FROM paths;

CREATE VIEW transaction_uncategorized_amounts AS
SELECT
  transactions.id AS transaction_id,
  transactions.amount_minor - COALESCE(sum(category_assignments.amount_minor), 0)
    AS uncategorized_amount_minor
FROM transactions
LEFT JOIN category_assignments ON category_assignments.transaction_id = transactions.id
WHERE transactions.kind IN ('income', 'expense')
GROUP BY transactions.id, transactions.amount_minor;

CREATE TRIGGER accounts_prevent_identity_change
BEFORE UPDATE OF nature, currency ON accounts
WHEN
  (NEW.nature != OLD.nature OR NEW.currency != OLD.currency)
  AND EXISTS (
    SELECT 1
    FROM transactions
    WHERE
      account_id = OLD.id
      OR source_account_id = OLD.id
      OR destination_account_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'account nature and currency cannot change after first transaction');
END;

CREATE TRIGGER accounts_require_zero_balance_before_archive
BEFORE UPDATE OF archived_at ON accounts
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT balance_minor FROM account_balances WHERE account_id = OLD.id) != 0
      THEN RAISE(ABORT, 'account balance must be zero before archive')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM vault_settings
      WHERE
        default_income_account_id = OLD.id
        OR default_expense_account_id = OLD.id
    )
      THEN RAISE(ABORT, 'default account must be cleared before archive')
  END;
END;

CREATE TRIGGER vault_settings_require_active_defaults
BEFORE UPDATE OF default_income_account_id, default_expense_account_id ON vault_settings
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM accounts
      WHERE
        id IN (
          NEW.default_income_account_id,
          NEW.default_expense_account_id
        )
        AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived account cannot be a default account')
  END;
END;

CREATE TRIGGER vault_settings_prevent_delete
BEFORE DELETE ON vault_settings
BEGIN
  SELECT RAISE(ABORT, 'vault settings cannot be deleted');
END;

CREATE TRIGGER transactions_require_active_accounts_insert
BEFORE INSERT ON transactions
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM accounts
      WHERE
        id IN (
          NEW.account_id,
          NEW.source_account_id,
          NEW.destination_account_id
        )
        AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived account cannot receive new transactions')
  END;
END;

CREATE TRIGGER transactions_require_active_accounts_financial_update
BEFORE UPDATE OF
  kind,
  account_id,
  amount_minor,
  source_account_id,
  source_amount_minor,
  destination_account_id,
  destination_amount_minor
ON transactions
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM accounts
      WHERE
        id IN (
          OLD.account_id,
          OLD.source_account_id,
          OLD.destination_account_id,
          NEW.account_id,
          NEW.source_account_id,
          NEW.destination_account_id
        )
        AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived account must be reactivated before financial edits')
  END;
END;

CREATE TRIGGER transactions_require_active_accounts_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM accounts
      WHERE
        id IN (
          OLD.account_id,
          OLD.source_account_id,
          OLD.destination_account_id
        )
        AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived account must be reactivated before transaction deletion')
  END;
END;

CREATE TRIGGER transfers_require_equal_same_currency_amounts_insert
BEFORE INSERT ON transactions
WHEN NEW.kind = 'transfer'
BEGIN
  SELECT CASE
    WHEN
      (
        SELECT currency
        FROM accounts
        WHERE id = NEW.source_account_id
      ) = (
        SELECT currency
        FROM accounts
        WHERE id = NEW.destination_account_id
      )
      AND NEW.source_amount_minor != NEW.destination_amount_minor
      THEN RAISE(ABORT, 'same-currency transfer amounts must match')
  END;
END;

CREATE TRIGGER transfers_require_equal_same_currency_amounts_update
BEFORE UPDATE OF
  kind,
  source_account_id,
  source_amount_minor,
  destination_account_id,
  destination_amount_minor
ON transactions
WHEN NEW.kind = 'transfer'
BEGIN
  SELECT CASE
    WHEN
      (
        SELECT currency
        FROM accounts
        WHERE id = NEW.source_account_id
      ) = (
        SELECT currency
        FROM accounts
        WHERE id = NEW.destination_account_id
      )
      AND NEW.source_amount_minor != NEW.destination_amount_minor
      THEN RAISE(ABORT, 'same-currency transfer amounts must match')
  END;
END;

CREATE TRIGGER categories_validate_insert
BEFORE INSERT ON categories
BEGIN
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM categories
      WHERE id = NEW.parent_id AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived category cannot receive children')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND (
      WITH RECURSIVE ancestors (id, parent_id, depth) AS (
        SELECT id, parent_id, 1
        FROM categories
        WHERE id = NEW.parent_id

        UNION ALL

        SELECT categories.id, categories.parent_id, ancestors.depth + 1
        FROM categories
        JOIN ancestors ON categories.id = ancestors.parent_id
      )
      SELECT COALESCE(max(depth), 0)
      FROM ancestors
    ) >= 3
      THEN RAISE(ABORT, 'category hierarchy cannot exceed three levels')
  END;
END;

CREATE TRIGGER categories_validate_parent_update
BEFORE UPDATE OF parent_id ON categories
WHEN NEW.parent_id IS NOT OLD.parent_id
BEGIN
  SELECT CASE
    WHEN NEW.parent_id = OLD.id
      THEN RAISE(ABORT, 'category cannot be its own parent')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE descendants (id) AS (
        SELECT id
        FROM categories
        WHERE parent_id = OLD.id

        UNION ALL

        SELECT categories.id
        FROM categories
        JOIN descendants ON categories.parent_id = descendants.id
      )
      SELECT 1
      FROM descendants
      WHERE id = NEW.parent_id
    )
      THEN RAISE(ABORT, 'category hierarchy cannot contain a cycle')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM categories
      WHERE id = NEW.parent_id AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived category cannot receive children')
  END;
  SELECT CASE
    WHEN (
      WITH RECURSIVE
        ancestors (id, parent_id, depth) AS (
          SELECT id, parent_id, 1
          FROM categories
          WHERE id = NEW.parent_id

          UNION ALL

          SELECT categories.id, categories.parent_id, ancestors.depth + 1
          FROM categories
          JOIN ancestors ON categories.id = ancestors.parent_id
        ),
        descendants (id, depth) AS (
          SELECT OLD.id, 1

          UNION ALL

          SELECT categories.id, descendants.depth + 1
          FROM categories
          JOIN descendants ON categories.parent_id = descendants.id
        )
      SELECT
        COALESCE((SELECT max(depth) FROM ancestors), 0)
        + COALESCE((SELECT max(depth) FROM descendants), 1)
    ) > 3
      THEN RAISE(ABORT, 'category hierarchy cannot exceed three levels')
  END;
END;

CREATE TRIGGER categories_prevent_archive_with_active_children
BEFORE UPDATE OF archived_at ON categories
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM categories
      WHERE parent_id = OLD.id AND archived_at IS NULL
    )
      THEN RAISE(ABORT, 'active child categories must be archived first')
  END;
END;

CREATE TRIGGER category_assignments_validate_insert
BEFORE INSERT ON category_assignments
BEGIN
  SELECT CASE
    WHEN (
      SELECT kind
      FROM transactions
      WHERE id = NEW.transaction_id
    ) NOT IN ('income', 'expense')
      THEN RAISE(ABORT, 'only income and expense can be categorized')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM categories
      WHERE id = NEW.category_id AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived category cannot receive assignments')
  END;
  SELECT CASE
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) * NEW.amount_minor <= 0
      THEN RAISE(ABORT, 'category assignment sign must match transaction amount')
  END;
  SELECT CASE
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) > 0
    AND (
      SELECT COALESCE(sum(amount_minor), 0)
      FROM category_assignments
      WHERE transaction_id = NEW.transaction_id
    ) + NEW.amount_minor > (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    )
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) < 0
    AND (
      SELECT COALESCE(sum(amount_minor), 0)
      FROM category_assignments
      WHERE transaction_id = NEW.transaction_id
    ) + NEW.amount_minor < (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    )
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
  END;
END;

CREATE TRIGGER category_assignments_validate_update
BEFORE UPDATE OF transaction_id, category_id, amount_minor ON category_assignments
BEGIN
  SELECT CASE
    WHEN (
      SELECT kind
      FROM transactions
      WHERE id = NEW.transaction_id
    ) NOT IN ('income', 'expense')
      THEN RAISE(ABORT, 'only income and expense can be categorized')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM categories
      WHERE id = NEW.category_id AND archived_at IS NOT NULL
    )
      THEN RAISE(ABORT, 'archived category cannot receive assignments')
  END;
  SELECT CASE
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) * NEW.amount_minor <= 0
      THEN RAISE(ABORT, 'category assignment sign must match transaction amount')
  END;
  SELECT CASE
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) > 0
    AND (
      SELECT COALESCE(sum(amount_minor), 0)
      FROM category_assignments
      WHERE transaction_id = NEW.transaction_id AND id != OLD.id
    ) + NEW.amount_minor > (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    )
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
    WHEN (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    ) < 0
    AND (
      SELECT COALESCE(sum(amount_minor), 0)
      FROM category_assignments
      WHERE transaction_id = NEW.transaction_id AND id != OLD.id
    ) + NEW.amount_minor < (
      SELECT amount_minor
      FROM transactions
      WHERE id = NEW.transaction_id
    )
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
  END;
END;

CREATE TRIGGER transactions_preserve_category_assignment_validity
BEFORE UPDATE OF kind, amount_minor ON transactions
WHEN EXISTS (
  SELECT 1
  FROM category_assignments
  WHERE transaction_id = OLD.id
)
BEGIN
  SELECT CASE
    WHEN NEW.kind NOT IN ('income', 'expense')
      THEN RAISE(ABORT, 'categorized transaction must remain income or expense')
  END;
  SELECT CASE
    WHEN NEW.amount_minor * (
      SELECT amount_minor
      FROM category_assignments
      WHERE transaction_id = OLD.id
      LIMIT 1
    ) <= 0
      THEN RAISE(ABORT, 'transaction amount sign must match category assignments')
  END;
  SELECT CASE
    WHEN NEW.amount_minor > 0
    AND (
      SELECT sum(amount_minor)
      FROM category_assignments
      WHERE transaction_id = OLD.id
    ) > NEW.amount_minor
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
    WHEN NEW.amount_minor < 0
    AND (
      SELECT sum(amount_minor)
      FROM category_assignments
      WHERE transaction_id = OLD.id
    ) < NEW.amount_minor
      THEN RAISE(ABORT, 'category assignments cannot exceed transaction amount')
  END;
END;

CREATE TRIGGER transaction_relations_validate_insert
BEFORE INSERT ON transaction_relations
BEGIN
  SELECT CASE
    WHEN NEW.relation_kind = 'refund_of' AND NOT (
      (
        SELECT kind = 'expense' AND amount_minor < 0
        FROM transactions
        WHERE id = NEW.source_transaction_id
      )
      AND (
        SELECT kind = 'expense' AND amount_minor > 0
        FROM transactions
        WHERE id = NEW.target_transaction_id
      )
    )
      THEN RAISE(ABORT, 'refund relation requires negative and positive expenses')
  END;
  SELECT CASE
    WHEN NEW.relation_kind = 'fee_for' AND NOT (
      (
        SELECT kind = 'expense' AND amount_minor > 0
        FROM transactions
        WHERE id = NEW.source_transaction_id
      )
      AND (
        SELECT kind = 'transfer'
        FROM transactions
        WHERE id = NEW.target_transaction_id
      )
    )
      THEN RAISE(ABORT, 'fee relation requires an expense and transfer')
  END;
END;

CREATE TRIGGER transaction_relations_validate_update
BEFORE UPDATE OF
  relation_kind,
  source_transaction_id,
  target_transaction_id
ON transaction_relations
BEGIN
  SELECT CASE
    WHEN NEW.relation_kind = 'refund_of' AND NOT (
      (
        SELECT kind = 'expense' AND amount_minor < 0
        FROM transactions
        WHERE id = NEW.source_transaction_id
      )
      AND (
        SELECT kind = 'expense' AND amount_minor > 0
        FROM transactions
        WHERE id = NEW.target_transaction_id
      )
    )
      THEN RAISE(ABORT, 'refund relation requires negative and positive expenses')
  END;
  SELECT CASE
    WHEN NEW.relation_kind = 'fee_for' AND NOT (
      (
        SELECT kind = 'expense' AND amount_minor > 0
        FROM transactions
        WHERE id = NEW.source_transaction_id
      )
      AND (
        SELECT kind = 'transfer'
        FROM transactions
        WHERE id = NEW.target_transaction_id
      )
    )
      THEN RAISE(ABORT, 'fee relation requires an expense and transfer')
  END;
END;

CREATE TRIGGER transactions_preserve_relation_validity
BEFORE UPDATE OF kind, amount_minor ON transactions
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM transaction_relations
      WHERE
        relation_kind = 'refund_of'
        AND source_transaction_id = OLD.id
        AND NOT (NEW.kind = 'expense' AND NEW.amount_minor < 0)
    )
      THEN RAISE(ABORT, 'refund source must remain a negative expense')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM transaction_relations
      WHERE
        relation_kind = 'refund_of'
        AND target_transaction_id = OLD.id
        AND NOT (NEW.kind = 'expense' AND NEW.amount_minor > 0)
    )
      THEN RAISE(ABORT, 'refund target must remain a positive expense')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM transaction_relations
      WHERE
        relation_kind = 'fee_for'
        AND source_transaction_id = OLD.id
        AND NOT (NEW.kind = 'expense' AND NEW.amount_minor > 0)
    )
      THEN RAISE(ABORT, 'fee source must remain a positive expense')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM transaction_relations
      WHERE
        relation_kind = 'fee_for'
        AND target_transaction_id = OLD.id
        AND NEW.kind != 'transfer'
    )
      THEN RAISE(ABORT, 'fee target must remain a transfer')
  END;
END;

CREATE TRIGGER change_records_prevent_update
BEFORE UPDATE ON change_records
BEGIN
  SELECT RAISE(ABORT, 'change records are immutable');
END;

CREATE TRIGGER change_records_prevent_delete
BEFORE DELETE ON change_records
BEGIN
  SELECT RAISE(ABORT, 'change records are immutable');
END;

INSERT INTO schema_migrations (version) VALUES (1);

COMMIT;
