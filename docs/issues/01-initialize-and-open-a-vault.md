# 01 — Initialize and open a Vault

**What to build:** Let a user initialize a local folder as a Vault, open it again safely, and
inspect its empty starting state through the Agent-facing MCP boundary.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] A user can initialize a folder as a Vault with its own SQLite database.
- [x] Initialization applies every pending schema migration exactly once.
- [x] Opening an existing Vault preserves its data and applies only newer migrations.
- [x] A new Vault contains one settings record and no seeded Accounts or Categories.
- [x] The core operation returns the Vault state without exposing MCP protocol concepts.
- [x] An MCP client can initialize or open a Vault and receive a concrete summary of the result.
- [x] Successfully initializing or opening a Vault remembers its path for later path-free MCP tool
      calls and future server processes.
- [x] An Agent receives a safe setup error when no Vault has been selected yet.
- [x] Tests exercise initialization and reopening through the highest available core operation seam
      using a temporary local Vault.
