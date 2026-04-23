# cowork-mcp — MCP Server distant

Serveur MCP (Model Context Protocol) qui expose la webhook queue à tous les clients Claude (Desktop, Web, iOS, Android) via le **Streamable HTTP transport**.

## Architecture

```
Claude (Desktop/Web/Mobile)
   │ HTTPS + MCP Streamable HTTP
   ▼
mcp.<DOMAIN>/t/<MCP_TOKEN>/mcp    ← Traefik TLS
   │ http interne Docker
   ▼
webhook-queue:3333
```

## Tools exposés

| Tool           | Effet                                                         |
|----------------|---------------------------------------------------------------|
| `queue_status` | Health check du serveur queue.                                |
| `queue_stats`  | Compteurs pending/read, uptime, TTL.                          |
| `queue_peek`   | Voir 50 derniers messages sans consommer.                     |
| `queue_next`   | Dépile FIFO (destructif).                                     |
| `queue_by_id`  | Récupère par correlation_id (peek ou claim).                  |
| `queue_send`   | Poste un message (déclenche n8n).                             |

## URL à saisir dans Claude

Dans **Paramètres → Connecteurs → Ajouter un connecteur personnalisé** :

- **Nom** : `Cowork Queue`
- **URL** : `https://mcp.<DOMAIN>/t/<MCP_TOKEN>/mcp`

Le `MCP_TOKEN` est défini dans le `.env` du VPS, généré à l'installation via `openssl rand -hex 16` (32 caractères hex).

## Variables d'environnement

| Variable             | Obligatoire | Rôle                                        |
|----------------------|-------------|---------------------------------------------|
| `PORT`               | non (8080)  | Port interne du container.                  |
| `QUEUE_INTERNAL_URL` | oui         | URL de la queue (ex : `http://webhook-queue:3333`). |
| `WEBHOOK_SECRET`     | oui         | Partagé avec la queue (header auth).        |
| `MCP_TOKEN`          | oui         | 32 hex min, protège l'URL publique.         |

## Rotation du token

1. Générer un nouveau token : `openssl rand -hex 16`
2. Mettre à jour `.env` sur le VPS : `MCP_TOKEN=<nouveau>`
3. `docker compose up -d cowork-mcp` (rebuild inutile, simple restart).
4. Mettre à jour l'URL dans la config Claude (supprimer l'ancien connecteur, en créer un nouveau).

## Développement local

```bash
cd mcp
npm install
npm run build
QUEUE_INTERNAL_URL=http://localhost:3333 \
WEBHOOK_SECRET=<ton-secret> \
MCP_TOKEN=dev-token-local-min-16-chars \
node dist/index.js
```

Puis MCP Inspector : `npx @modelcontextprotocol/inspector` → `http://localhost:8080/t/dev-token-local-min-16-chars/mcp`.

## Sécurité

- Token embarqué dans l'URL, validé en **timing-safe compare**.
- Mismatch → 404 (pas 401, pour ne pas divulguer l'existence du endpoint).
- CORS permissif (`*`) car Claude Web se connecte depuis n'importe quel domaine.
- HTTPS obligatoire en prod (Traefik + Let's Encrypt via Cloudflare).
