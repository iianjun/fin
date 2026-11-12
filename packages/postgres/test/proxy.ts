import { createServer, createConnection, type Socket } from 'node:net'
import { once } from 'node:events'

/** Frame-aware local PostgreSQL fault boundary: delay queries or drop actual server acknowledgements. */
export async function openPostgresProxy(
  connectionString: string,
  hooks: {
    beforeQuery?(sql: string): void | Promise<void>
    afterCommand?(command: string): 'disconnect' | void
  },
) {
  const target = new URL(connectionString)
  const destination = { host: target.hostname, port: Number(target.port || 5432) }
  const sockets = new Set<Socket>()
  const server = createServer((front) => {
    const back = createConnection(destination)
    sockets.add(front)
    sockets.add(back)
    let startup = true,
      incoming = Buffer.alloc(0),
      outgoing = Buffer.alloc(0)
    let queue = Promise.resolve()
    front.on('error', () => {})
    back.on('error', () => front.destroy())
    front.on('close', () => {
      sockets.delete(front)
      back.destroy()
    })
    back.on('close', () => {
      sockets.delete(back)
      front.destroy()
    })
    front.on('data', (bytes) => {
      incoming = Buffer.concat([incoming, bytes])
      while (incoming.length >= (startup ? 4 : 5)) {
        const length = startup ? incoming.readInt32BE(0) : incoming.readInt32BE(1) + 1
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
            if (sql !== undefined) await hooks.beforeQuery?.(sql)
            if (!back.destroyed) back.write(frame)
          })
          .catch(() => {
            front.destroy()
            back.destroy()
          })
      }
    })
    back.on('data', (bytes) => {
      outgoing = Buffer.concat([outgoing, bytes])
      while (outgoing.length >= 5) {
        const length = outgoing.readInt32BE(1) + 1
        if (outgoing.length < length) return
        const frame = outgoing.subarray(0, length)
        outgoing = outgoing.subarray(length)
        if (
          frame[0] === 67 &&
          hooks.afterCommand?.(frame.subarray(5, frame.length - 1).toString()) === 'disconnect'
        ) {
          front.destroy()
          back.destroy()
          return
        }
        front.write(frame)
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing proxy port')
  target.hostname = '127.0.0.1'
  target.port = String(address.port)
  target.searchParams.set('sslmode', 'disable')
  return {
    connectionString: target.toString(),
    async dispose() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
