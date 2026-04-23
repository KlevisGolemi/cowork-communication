// ═══════════════════════════════════════════════════════════════
//  tools.ts — enregistre les 6 outils MCP exposés à Claude.
//  Chaque tool wrappe un appel queueClient.ts et formate la réponse
//  pour Claude (content[] + isError en cas de status >= 400).
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { queue, type QueueResult } from './queueClient.js'

// Formate une réponse HTTP upstream en format MCP standard.
// - 2xx           → content text = JSON pretty, isError = false
// - 4xx / 5xx     → content text = message d'erreur lisible, isError = true
function format(res: QueueResult, label: string) {
  const json = JSON.stringify(res.body, null, 2)
  if (res.status >= 400) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: `${label} a échoué (HTTP ${res.status}):\n${json}`
      }]
    }
  }
  return {
    content: [{ type: 'text' as const, text: json }]
  }
}

export function registerTools(server: McpServer): void {

  // ─── queue_status ──────────────────────────────────────────
  server.registerTool(
    'queue_status',
    {
      title: 'Statut de la queue',
      description: 'Health check du serveur webhook queue (uptime). Pas d\'auth requise côté queue.',
      inputSchema: {}
    },
    async () => format(await queue.status(), 'queue_status')
  )

  // ─── queue_stats ───────────────────────────────────────────
  server.registerTool(
    'queue_stats',
    {
      title: 'Statistiques de la queue',
      description: 'Compteurs détaillés : messages pending, lus, uptime, TTL et intervalle de cleanup.',
      inputSchema: {}
    },
    async () => format(await queue.stats(), 'queue_stats')
  )

  // ─── queue_peek ────────────────────────────────────────────
  server.registerTool(
    'queue_peek',
    {
      title: 'Inspecter la queue',
      description: 'Renvoie jusqu\'à 50 messages les plus récents SANS les consommer (statut pending + read). Utile pour diagnostiquer sans impact.',
      inputSchema: {}
    },
    async () => format(await queue.peek(), 'queue_peek')
  )

  // ─── queue_next ────────────────────────────────────────────
  server.registerTool(
    'queue_next',
    {
      title: 'Dépiler le prochain message (FIFO)',
      description: 'Destructif : récupère et marque "read" le plus ancien message pending. Si la queue est vide, renvoie {empty:true, item:null}. Usage : consommation séquentielle des résultats n8n.',
      inputSchema: {}
    },
    async () => format(await queue.next(), 'queue_next')
  )

  // ─── queue_by_id ───────────────────────────────────────────
  server.registerTool(
    'queue_by_id',
    {
      title: 'Récupérer un message par correlation ID',
      description: 'Pattern request-response : récupère LE message qui matche ce correlation_id (fourni à l\'origine dans x-correlation-id). Par défaut destructif (claim). Avec peek=true, lecture non-destructive quel que soit le statut. 404 = pas encore arrivé ; 410 = déjà consommé.',
      inputSchema: {
        correlation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('ID unique attendu (regex [A-Za-z0-9_-]{1,128}).'),
        peek: z.boolean().optional().describe('Si true, lecture non-destructive. Défaut false (claim).')
      }
    },
    async ({ correlation_id, peek }) =>
      format(await queue.byId(correlation_id, peek === true), 'queue_by_id')
  )

  // ─── queue_send ────────────────────────────────────────────
  server.registerTool(
    'queue_send',
    {
      title: 'Poster un message dans la queue',
      description: 'Écrit un payload dans la queue (déclenche en aval le flux n8n qui polle). Si correlation_id fourni, il doit être unique — doublon renvoie 409.',
      inputSchema: {
        payload: z.record(z.unknown()).describe('Objet JSON arbitraire. Sera stocké tel quel et renvoyé aux consommateurs.'),
        correlation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()
          .describe('Optionnel. Si fourni, permet ensuite queue_by_id avec le même ID. Regex [A-Za-z0-9_-]{1,128}.')
      }
    },
    async ({ payload, correlation_id }) =>
      format(await queue.send(payload, correlation_id), 'queue_send')
  )
}
