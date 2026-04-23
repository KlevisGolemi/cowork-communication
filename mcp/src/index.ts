// ═══════════════════════════════════════════════════════════════
//  cowork-mcp — serveur MCP distant (Streamable HTTP).
//  Exposé derrière Traefik sur mcp.<DOMAIN>, authentification par
//  token embarqué dans l'URL (path segment) — check timing-safe.
// ═══════════════════════════════════════════════════════════════

import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { registerTools } from './tools.js'

// ─── CONFIG ──────────────────────────────────────────────────
const PORT      = Number(process.env.PORT || 8080)
const MCP_TOKEN = process.env.MCP_TOKEN || ''
const NODE_ENV  = process.env.NODE_ENV || 'production'

if (!MCP_TOKEN || MCP_TOKEN.length < 16) {
  console.error(JSON.stringify({ level: 'error', msg: 'MCP_TOKEN manquant ou trop court (min 16 chars)' }))
  process.exit(1)
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }))
}

// ─── APP ─────────────────────────────────────────────────────
const app = express()

// Derrière Traefik + Cloudflare → faire confiance à la chaîne proxy.
app.set('trust proxy', true)

app.use(express.json({ limit: '1mb' }))
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Authorization']
}))

// ─── HEALTH CHECK ────────────────────────────────────────────
// Public, sans token : Traefik + monitoring tapent ici.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime_s: Math.floor(process.uptime()) })
})

// ─── AUTH : vérif timing-safe du token dans le path ──────────
function checkToken(req: Request, res: Response, next: NextFunction) {
  const provided = String(req.params.token || '')
  const a = Buffer.from(provided)
  const b = Buffer.from(MCP_TOKEN)
  const ok = a.length === b.length && timingSafeEqual(a, b)
  if (!ok) {
    // 404 pour ne pas révéler l'existence du endpoint sur token foireux.
    log('warn', 'Token MCP invalide', { ip: req.ip, path: req.path })
    return res.status(404).send('Not found')
  }
  next()
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>()

async function handleRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  let transport: StreamableHTTPServerTransport | undefined

  if (sessionId && transports.has(sessionId)) {
    // Session existante — réutilise le transport.
    transport = transports.get(sessionId)!
  } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
    // Nouvelle session : crée le transport + le server MCP.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport!)
        log('info', 'Session MCP ouverte', { sessionId: sid })
      }
    })

    transport.onclose = () => {
      if (transport?.sessionId) {
        transports.delete(transport.sessionId)
        log('info', 'Session MCP fermée', { sessionId: transport.sessionId })
      }
    }

    const server = new McpServer({ name: 'cowork-mcp', version: '1.0.0' })
    registerTools(server)
    await server.connect(transport)
  } else {
    // Ni session existante ni InitializeRequest → erreur JSON-RPC.
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session id, or not an initialize request' },
      id: null
    })
    return
  }

  await transport.handleRequest(req, res, req.body)
}

// ─── ROUTES MCP ──────────────────────────────────────────────
const router = express.Router({ mergeParams: true })
router.post('/',   handleRequest)
router.get('/',    handleRequest)
router.delete('/', handleRequest)

// Path : /t/:token/mcp
app.use('/t/:token/mcp', checkToken, router)

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────
process.on('SIGTERM', () => {
  log('info', 'SIGTERM reçu, fermeture des sessions')
  for (const t of transports.values()) {
    try { t.close() } catch { /* ignore */ }
  }
  process.exit(0)
})

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log('info', `cowork-mcp up on :${PORT}`, { node_env: NODE_ENV })
})
