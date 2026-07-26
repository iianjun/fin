# Separate the MCP adapter from the core package

fin uses a pnpm monorepo with `apps/mcp` for the stdio adapter and `packages/core` for reusable product behavior. This keeps MCP-specific concerns out of the core while avoiding premature packages for internal layers that do not yet need independent interfaces.
