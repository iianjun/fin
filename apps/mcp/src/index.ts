#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createFinServer } from './server.js'

const server = createFinServer()
const transport = new StdioServerTransport()

await server.connect(transport)
