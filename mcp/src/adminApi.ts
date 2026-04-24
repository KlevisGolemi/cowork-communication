// ═══════════════════════════════════════════════════════════════
//  adminApi.ts — routes REST pour l'interface d'administration.
//  Montées sous /t/:token/api (token déjà vérifié par checkToken).
//  - /config   → URLs publiques (non-secret)
//  - /secrets  → secrets en clair (déjà authed par token)
//  - /status   → proxy queue
//  - /stats    → proxy queue
//  - /peek     → proxy queue
//  - /next     → proxy queue
//  - /by-id/:cid → proxy queue
//  - /send     → proxy queue
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express'
import { queue } from './queueClient.js'

// Lus depuis l'env (.env partagé entre tous les containers via env_file)
const DOMAIN         = process.env.DOMAIN          || ''
const MCP_DOMAIN     = process.env.MCP_DOMAIN      || ''
const MCP_TOKEN      = process.env.MCP_TOKEN        || ''
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET   || ''

// ─── Helper ──────────────────────────────────────────────────
async function proxyQueue<T>(
  res: Response,
  fn: () => Promise<{ status: number; body: T }>
) {
  try {
    const r = await fn()
    res.status(r.status).json(r.body)
  } catch {
    res.status(502).json({ error: 'Queue unreachable' })
  }
}

// ─── Router ──────────────────────────────────────────────────
export function createAdminRouter(): Router {
  const router = Router({ mergeParams: true })

  // ── Config publique (URLs, domaines) ──────────────────────
  router.get('/config', (_req: Request, res: Response) => {
    const mcpConnectorUrl = MCP_DOMAIN && MCP_TOKEN
      ? `https://${MCP_DOMAIN}/t/${MCP_TOKEN}/mcp`
      : ''
    const webhookApiUrl = DOMAIN
      ? `https://${DOMAIN}/webhook`
      : ''

    res.json({ mcpConnectorUrl, webhookApiUrl, mcpDomain: MCP_DOMAIN, domain: DOMAIN })
  })

  // ── Secrets (déjà protégés par le token dans le path) ─────
  router.get('/secrets', (_req: Request, res: Response) => {
    res.json({ webhookSecret: WEBHOOK_SECRET, mcpToken: MCP_TOKEN })
  })

  // ── Proxies queue ─────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) =>
    proxyQueue(res, () => queue.status())
  )

  router.get('/stats', (_req: Request, res: Response) =>
    proxyQueue(res, () => queue.stats())
  )

  router.get('/peek', (_req: Request, res: Response) =>
    proxyQueue(res, () => queue.peek())
  )

  router.get('/next', (_req: Request, res: Response) =>
    proxyQueue(res, () => queue.next())
  )

  router.get('/by-id/:cid', (req: Request, res: Response) => {
    const peek = req.query.peek !== 'false'
    return proxyQueue(res, () => queue.byId(req.params.cid, peek))
  })

  router.post('/send', (req: Request, res: Response) => {
    const { payload, correlationId } = req.body as {
      payload?: unknown
      correlationId?: string
    }
    return proxyQueue(res, () => queue.send(payload, correlationId))
  })

  return router
}
