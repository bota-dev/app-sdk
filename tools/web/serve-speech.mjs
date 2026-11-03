import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSpeechHost } from './speech-host.mjs'

const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self), camera=(), display-capture=()',
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://*.livekit.cloud wss://*.livekit.cloud; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'",
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' }

/** An operator-only loopback server, never a deployed authentication service. */
export async function startSpeechLab(config, options = {}) {
  const directory = options.directory ?? fileURLToPath(new URL('../../tests/consumers/web-vite/dist', import.meta.url))
  // Refuse to start until the actual consumer is built. This never runs Vite or installs packages.
  await readFile(resolve(directory, 'speech.html'))
  let handler, origin
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    const abort = new AbortController()
    response.once('close', () => abort.abort())
    request.once('aborted', () => abort.abort())
    try {
      if (!origin || request.headers.host !== new URL(origin).host ||
          !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
        response.writeHead(403, headers); response.end(); return
      }
      const url = new URL(request.url, origin)
      if (url.pathname.startsWith('/speech-host/')) {
        const value = new Request(url, { method: request.method, headers: request.headers,
          ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: request, duplex: 'half' }), signal: abort.signal })
        const result = await handler(value)
        response.writeHead(result.status, { ...headers, 'content-type': 'application/json' })
        response.end(Buffer.from(await result.arrayBuffer())); return
      }
      const path = url.pathname === '/' ? '/speech.html' : url.pathname
      if (request.method !== 'GET' || url.search || (path !== '/speech.html' &&
          !/^\/assets\/(?!speech-check-)[A-Za-z0-9_-]+\.(?:js|css|wasm)$/.test(path))) {
        response.writeHead(404, headers); response.end(); return
      }
      const content = await readFile(resolve(directory, `.${path}`))
      const extension = path.slice(path.lastIndexOf('.'))
      response.writeHead(200, { ...headers, 'content-type': types[extension] }); response.end(content)
    } catch {
      if (!response.headersSent) response.writeHead(503, { ...headers, 'content-type': 'application/json' })
      response.end('{"error":{"code":"unavailable"}}')
    } finally { abort.abort() }
  })
  server.maxConnections = 16
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4173, '127.0.0.1', resolve) })
    origin = `http://127.0.0.1:${server.address().port}`
    handler = createSpeechHost({ ...config, origin }, { ...(options.fetch ? { fetch: options.fetch } : {}) })
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  return { origin, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env, port = Number(env.BOTA_SPEECH_PORT ?? 4173)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port')
    const lab = await startSpeechLab({ apiOrigin: env.BOTA_SPEECH_API_ORIGIN, apiKey: env.BOTA_SPEECH_API_KEY,
      projectId: env.BOTA_SPEECH_PROJECT_ID, sessionId: env.BOTA_SPEECH_SESSION_ID,
      roles: Object.fromEntries(['a', 'b'].map(role => [role, {
        participantId: env[`BOTA_SPEECH_${role.toUpperCase()}_PARTICIPANT_ID`],
        memberGeneration: Number(env[`BOTA_SPEECH_${role.toUpperCase()}_MEMBER_GENERATION`]),
        code: env[`BOTA_SPEECH_${role.toUpperCase()}_CODE`],
      }])) }, { port })
    console.log(`Conversation lab: ${lab.origin}/speech.html`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void lab.close() })
  } catch { console.error('Conversation lab could not start. Check the built consumer and required host configuration.'); process.exitCode = 1 }
}
