// ═══════════════════════════════════════════════════════════════
//  queueClient.ts — client HTTP vers le service webhook-queue.
//  Toutes les routes tapent sur QUEUE_INTERNAL_URL (réseau Docker),
//  avec le header `x-webhook-secret` déjà injecté.
// ═══════════════════════════════════════════════════════════════

const BASE = process.env.QUEUE_INTERNAL_URL || 'http://webhook-queue:3333'
const SECRET = process.env.WEBHOOK_SECRET || ''

if (!SECRET) {
  // Fail-fast : sans secret côté MCP, toutes les routes auth échoueraient en 401.
  throw new Error('WEBHOOK_SECRET manquant dans l\'environnement du container MCP')
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export interface QueueResult {
  status: number
  body: JsonValue
}

async function call(path: string, init: RequestInit = {}): Promise<QueueResult> {
  const headers = new Headers(init.headers)
  headers.set('x-webhook-secret', SECRET)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  let body: JsonValue
  try {
    body = text ? JSON.parse(text) as JsonValue : null
  } catch {
    body = { __raw: text } as JsonValue
  }
  return { status: res.status, body }
}

export const queue = {
  next:   ()                 => call('/next'),
  peek:   ()                 => call('/peek'),
  status: ()                 => call('/status'),
  stats:  ()                 => call('/stats'),

  byId: (cid: string, peek: boolean) => {
    const qs = peek ? '?peek=true' : ''
    return call(`/by-id/${encodeURIComponent(cid)}${qs}`)
  },

  send: (payload: unknown, correlationId?: string) => {
    const headers: Record<string, string> = {}
    if (correlationId) headers['x-correlation-id'] = correlationId
    return call('/webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {})
    })
  }
}
