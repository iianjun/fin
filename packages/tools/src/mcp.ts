import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { FinError } from '@fin-kit/core'
import type { FinTool, FinVaultAccess } from './index.js'

/** Register only; hosts own authentication, connection, transport and shutdown. */
export function registerFinTools(
  server: McpServer,
  tools: Readonly<Record<string, FinTool>>,
  options: {
    getAccess?: (context: ServerContext) => FinVaultAccess | Promise<FinVaultAccess>
  } = {},
) {
  const ids = new Set<string>()
  for (const tool of Object.values(tools)) {
    if (ids.has(tool.id)) throw new Error(`Duplicate tool ID: ${tool.id}`)
    ids.add(tool.id)
  }
  for (const tool of Object.values(tools)) {
    server.registerTool(
      tool.id,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input, context) => {
        try {
          const data = await tool.execute(input, await options.getAccess?.(context))
          const result = { data }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          }
        } catch (cause) {
          const error =
            cause instanceof FinError
              ? {
                  code: cause.code,
                  message: cause.message,
                  application: cause.application,
                  ...(cause.target ? { target: cause.target } : {}),
                  recovery: cause.recovery,
                }
              : {
                  code: 'OUTCOME_UNKNOWN',
                  message: 'The tool did not return a confirmed result.',
                  application: 'unknown',
                  recovery:
                    'Inspect current financial state and Change Records before deciding whether to submit another operation. Do not automatically retry.',
                }
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error }) }],
            structuredContent: { error },
          }
        }
      },
    )
  }
}
