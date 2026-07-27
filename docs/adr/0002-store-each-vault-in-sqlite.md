# Store each vault in SQLite

Each vault stores its financial data, configuration, and change history in its own SQLite database
file. This preserves the vault as an independently movable and backupable local folder, provides
transactional relational storage without a database server, and avoids mixing vaults in a shared
database.
