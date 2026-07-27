# 01 — Initialize and open a Vault

**What to build:** Let a user initialize a local folder as a Vault, open it again safely, and
inspect its empty starting state through the Agent-facing MCP boundary.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A user can initialize a folder as a Vault with its own SQLite database.
- [ ] Initialization applies every pending schema migration exactly once.
- [ ] Opening an existing Vault preserves its data and applies only newer migrations.
- [ ] A new Vault contains one settings record and no seeded Accounts or Categories.
- [ ] The core operation returns the Vault state without exposing MCP protocol concepts.
- [ ] An MCP client can initialize or open a Vault and receive a concrete summary of the result.
- [ ] Tests exercise initialization and reopening through the highest available core operation seam
      using a temporary local Vault.
