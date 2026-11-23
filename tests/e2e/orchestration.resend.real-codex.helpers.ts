import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import path from 'node:path'

// E-08 helpers: a loopback HTTP proxy in front of the Worker control surface that lets the test
// choose how the CLI loses the reply, plus the CLI runner that points at that proxy through env
// (the service token never appears in argv). The real Worker still processes the request.

const cliPath = path.resolve(__dirname, '../../out/cli/opencove.mjs')

export interface CliConnection {
  endpoint: string
  token: string
}

interface ControlSurfaceFile {
  version?: unknown
  hostname?: unknown
  port?: unknown
  token?: unknown
}

/** Live Worker connection file of the launched app, the same one `--user-data` resolves. */
export async function readWorkerConnection(userDataDir: string): Promise<CliConnection> {
  const raw = JSON.parse(
    await readFile(path.join(userDataDir, 'worker-control-surface.json'), 'utf8'),
  ) as ControlSurfaceFile
  if (
    raw.version !== 1 ||
    typeof raw.hostname !== 'string' ||
    typeof raw.port !== 'number' ||
    typeof raw.token !== 'string'
  ) {
    throw new Error('worker-control-surface.json is not a version 1 connection')
  }
  return { endpoint: `http://${raw.hostname}:${raw.port}`, token: raw.token }
}

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise(done => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { env, timeout: 30_000 },
      (error, stdout, stderr) =>
        done({
          exitCode: error ? Number((error as { code?: unknown }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    )
  })
}

/** Runs the real CLI against the proxy while the token travels only through the environment. */
export function cliThroughProxy(
  userDataDir: string,
  connection: CliConnection,
  proxyUrl: string,
  args: string[],
): Promise<CliResult> {
  return runCli(args, {
    ...process.env,
    OPENCOVE_USER_DATA_DIR: userDataDir,
    OPENCOVE_CONTROL_URL: proxyUrl,
    OPENCOVE_CONTROL_TOKEN: connection.token,
  })
}

export type CliProxyMode = 'hold-response' | 'drop-request'

export interface CliProxy {
  url: string
  /** Request URLs the proxy received, for evidence that the CLI did reach or skip the Worker. */
  received: () => string[]
  close: () => Promise<void>
}

/**
 * `hold-response`: forwards the request and swallows the Worker reply, so the dispatch is accepted
 * and the CLI hits its own deadline (exit 124). `drop-request`: reads the request and never
 * forwards it, so the timeout leaves no dispatch behind.
 */
export async function startCliProxy(target: string, mode: CliProxyMode): Promise<CliProxy> {
  const received: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((req, _res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      received.push(req.url ?? '')
      if (mode === 'drop-request') {
        return
      }
      void forward(target, req, Buffer.concat(chunks)).catch(() => {
        // The CLI may abort before the Worker answers; the dispatch already reached it.
      })
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    received: () => [...received],
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}

async function forward(target: string, req: IncomingMessage, body: Buffer): Promise<void> {
  const upstream = await fetch(`${target}${req.url ?? ''}`, {
    method: req.method,
    headers: {
      authorization: String(req.headers.authorization ?? ''),
      'content-type': String(req.headers['content-type'] ?? 'application/json'),
      'x-opencove-protocol': String(req.headers['x-opencove-protocol'] ?? ''),
    },
    body,
  })
  // Drain the Worker reply and keep it away from the CLI; the client timeout is the observable.
  await upstream.arrayBuffer()
}
