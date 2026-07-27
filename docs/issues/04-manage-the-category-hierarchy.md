# 04 — Manage the Category hierarchy

**What to build:** Let a user build and maintain a personal Category hierarchy with clear paths,
bounded depth, and safe archival.

**Blocked by:** 01 — Initialize and open a Vault.

**Status:** ready-for-agent

- [ ] A user can create a root Category or a child Category at any allowed level.
- [ ] Category paths contain at most three levels and cannot contain cycles.
- [ ] Category names are unique among siblings but may repeat under different parents.
- [ ] A user can list Categories with their complete current paths and archive state.
- [ ] A user can rename or move a Category and see the new path used consistently.
- [ ] A user can archive and reactivate a Category without losing historical references.
- [ ] An archived Category cannot receive new children or Category Assignments.
- [ ] Category mutations write immutable Change Records atomically.
- [ ] MCP responses state the complete path that was created, changed, moved, or archived.
- [ ] Tests cover hierarchy creation, movement, cycle prevention, depth, uniqueness, and archival.
