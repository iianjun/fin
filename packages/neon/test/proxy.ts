import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

// Routing is confined to the test process; production always selects native Node WebSocket.
const routes = new Map<string, string>()
const NativeWebSocket = globalThis.WebSocket
const clients = new Map<string, Set<WebSocket | InstanceType<typeof NativeWebSocket>>>()
class RoutedWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const hostname = new URL(url).hostname
    super(routes.get(hostname) ?? url, protocols)
    const owned = clients.get(hostname)
    owned?.add(this)
    this.addEventListener('close', () => owned?.delete(this), { once: true })
  }
}
globalThis.WebSocket = RoutedWebSocket

/** Actual PostgreSQL frames over WS, with loss/delay injection below the driver.
 * Local targets bridge WS to TCP; hosted targets bridge WS to the real Neon WS endpoint.
 * Each accepted socket owns exactly one upstream connection for its entire lifetime. */
export async function openNeonProxy(
  connectionString: string,
  hooks: {
    beforeQuery?(sql: string, session: number): void | Promise<void>
    afterCommand?(command: string, session: number): 'disconnect' | 'malformed' | 'stall' | void
  } = {},
) {
  const target = new URL(connectionString)
  const hosted = !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const connections = new Set<() => void>()
  let sessions = 0
  server.on('connection', (front) => {
    const session = ++sessions
    const back: Socket | WebSocket = hosted
      ? new WebSocket(`wss://${target.hostname}/v2`, { followRedirects: false })
      : createConnection({ host: target.hostname, port: Number(target.port || 5432) })
    let startup = true
    let stalled = false
    let incoming = Buffer.alloc(0),
      outgoing = Buffer.alloc(0)
    let queue = once(back, hosted ? 'open' : 'connect').then(() => {})
    const disconnect = () => {
      front.terminate()
      if (back instanceof WebSocket) back.terminate()
      else back.destroy()
      connections.delete(disconnect)
    }
    connections.add(disconnect)
    front.on('error', disconnect)
    back.on('error', disconnect)
    front.on('close', disconnect)
    back.on('close', disconnect)
    void queue.catch(disconnect)
    front.on('message', (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data
      incoming = Buffer.concat([incoming, bytes])
      while (incoming.length >= (startup ? 4 : 5)) {
        const length = startup ? incoming.readInt32BE(0) : incoming.readInt32BE(1) + 1
        if (length < 4 || length > 64 * 1024 * 1024) return disconnect()
        if (incoming.length < length) return
        const frame = incoming.subarray(0, length)
        incoming = incoming.subarray(length)
        let sql: string | undefined
        if (!startup && frame[0] === 81) sql = frame.subarray(5, frame.length - 1).toString()
        if (!startup && frame[0] === 80) {
          const start = frame.indexOf(0, 5) + 1
          sql = frame.subarray(start, frame.indexOf(0, start)).toString()
        }
        startup = false
        queue = queue
          .then(async () => {
            if (sql !== undefined) await hooks.beforeQuery?.(sql, session)
            if (back instanceof WebSocket) {
              if (back.readyState === WebSocket.OPEN) back.send(frame)
            } else if (!back.destroyed) back.write(frame)
          })
          .catch(disconnect)
      }
    })
    const receive = (bytes: Buffer) => {
      if (stalled) return
      outgoing = Buffer.concat([outgoing, bytes])
      while (outgoing.length >= 5) {
        const length = outgoing.readInt32BE(1) + 1
        if (length < 5 || length > 64 * 1024 * 1024) return disconnect()
        if (outgoing.length < length) return
        const frame = outgoing.subarray(0, length)
        outgoing = outgoing.subarray(length)
        const action =
          frame[0] === 67
            ? hooks.afterCommand?.(frame.subarray(5, frame.length - 1).toString(), session)
            : undefined
        if (action === 'disconnect') return disconnect()
        if (action === 'stall') {
          stalled = true
          return
        }
        if (front.readyState === WebSocket.OPEN) {
          if (action === 'malformed') {
            const invalid = Buffer.from(frame)
            invalid.fill(88, 5, invalid.length - 1)
            front.send(invalid)
          } else front.send(frame)
        }
      }
    }
    if (back instanceof WebSocket)
      back.on('message', (data) =>
        receive(
          Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data,
        ),
      )
    else back.on('data', receive)
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing proxy port')
  const hostname = `fin-${randomUUID()}.invalid`
  const webSocketUrl = `ws://127.0.0.1:${address.port}`
  routes.set(hostname, webSocketUrl)
  clients.set(hostname, new Set())
  const routed = new URL(connectionString)
  routed.hostname = hostname
  routed.port = ''
  return {
    connectionString: routed.toString(),
    webSocketUrl,
    get openClients() {
      return clients.get(hostname)?.size ?? 0
    },
    get sessions() {
      return sessions
    },
    async disconnect() {
      const closed = [...(clients.get(hostname) ?? [])].map(
        (client) =>
          new Promise<void>((resolve) =>
            client.addEventListener('close', () => resolve(), { once: true }),
          ),
      )
      for (const disconnect of connections) disconnect()
      await Promise.all(closed)
    },
    async dispose() {
      routes.delete(hostname)
      clients.delete(hostname)
      for (const disconnect of connections) disconnect()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
