# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Two Docker services that decouple n8n (producer) from Cowork (consumer) via a durable HTTP queue with Claude MCP integration:

- **`webhook-queue`** (`server.js`) — SQLite-backed HTTP queue, plain Node.js/Express, no build step.
- **`cowork-mcp`** (`mcp/`) — TypeScript MCP server (Streamable HTTP) that exposes the queue as Claude tools + admin REST API + admin SPA.

Both services share a single `.env` file and run behind Traefik + Let's Encrypt.

## Commands

### Queue server (no build needed)
```bash
node server.js                          # local dev run
NODE_ENV=development node server.js     # dev mode: auth disabled without WEBHOOK_SECRET
```

### MCP server
```bash
cd mcp
npm run build     # tsc → dist/
npm run dev       # tsc --watch
node dist/index.js
```

### Docker (primary deployment path)
```bash
./install.sh                            # interactive first-time setup
docker compose up -d --build            # rebuild and restart both services
docker compose logs -f webhook-queue    # queue logs
docker compose logs -f cowork-mcp       # MCP logs
./uninstall.sh                          # tear down (--yes for non-interactive)
```

## Architecture

```
Claude (Desktop/Web/Mobile)
        │  HTTPS /t/<MCP_TOKEN>/mcp
        ▼
cowork-mcp (port 8080, mcp.<DOMAIN>)
        │  HTTP docker-internal → webhook-queue:3333
        ▼
webhook-queue (port 3333, queue.<DOMAIN>)
        │  POST /webhook
        ▼
n8n (producer & consumer)
```

### webhook-queue (`server.js`)
Single-file Express app. All state is in a SQLite DB (`/data/queue.db` via Docker volume).

- Messages have `status` = `pending` | `read`; deleted by TTL cleanup (default 48 h).
- `GET /next` and `GET /by-id/:cid` use `UPDATE … RETURNING` for atomic claim (eliminates race conditions between concurrent consumers, requires SQLite ≥ 3.35).
- `GET /peek` supports `?limit=N&offset=M` (1 ≤ limit ≤ 500, default 50/0) — response includes `limit`, `offset`, `stats.total` for client-side pagination.
- `DELETE /message/:id` — supprime un message par UUID interne (404 si absent).
- `correlation_id` uniqueness is enforced via a partial unique index (`WHERE correlation_id IS NOT NULL`), added via idempotent migration on startup.
- Auth: `x-webhook-secret` header, timing-safe comparison. Fail-fast: won't start in production without the secret.
- Rate limit: 100 req/min per IP on `POST /webhook` only.

### cowork-mcp (`mcp/`)
TypeScript, compiled to `mcp/dist/`. Three surfaces mounted under `/t/:token/*`:

| Path | Purpose |
|---|---|
| `/t/:token/mcp` | MCP Streamable HTTP endpoint (per-session transport map) |
| `/t/:token/api/*` | REST admin API proxying to webhook-queue |
| `/t/:token/ui` | Admin SPA (`mcp/public/index.html`) |

Token is verified timing-safe; invalid token returns `404` (no endpoint disclosure).

**Source layout:**
- `mcp/src/index.ts` — Express app, token auth middleware, session management
- `mcp/src/tools.ts` — 8 MCP tools registered via `registerTools()`, each wrapping `queueClient`
- `mcp/src/queueClient.ts` — HTTP client to webhook-queue (injects `WEBHOOK_SECRET` header, typed `QueueResult`); `peek(limit, offset)` forwards pagination params
- `mcp/src/adminApi.ts` — REST router proxying queue operations + exposes config/secrets; `/peek` forwards `?limit`/`?offset`; `DELETE /clear` and `DELETE /message/:id` added

**MCP tools (8 total):**
`queue_status`, `queue_stats`, `queue_peek`, `queue_next`, `queue_by_id`, `queue_send`, `queue_clear`, `queue_delete`

**Admin SPA (`mcp/public/index.html`):**
Single-file Alpine.js v3 + Tailwind CDN + Chart.js 4 app. Key features:
- Queue Explorer: paginated (50/page, "Charger plus" button), bar chart arrivals par période (1m→24h), delete par message, clear avec confirmation
- Dashboard: sparkline Chart.js, 4 stat cards, system monitor

## Environment Variables

Shared `.env` used by both containers:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DOMAIN` | yes | — | Public hostname for webhook-queue |
| `MCP_DOMAIN` | yes | — | Public hostname for cowork-mcp |
| `WEBHOOK_SECRET` | yes (prod) | — | Header auth for queue API |
| `MCP_TOKEN` | yes | — | URL token for MCP/admin, min 16 chars |
| `PORT` | no | `3333` | Internal port for webhook-queue |
| `DB_PATH` | no | `/data/queue.db` | SQLite path inside container |
| `TTL_HOURS` | no | `48` | Message retention |
| `CLEANUP_INTERVAL_MIN` | no | `60` | TTL cleanup frequency |

The MCP container also receives `QUEUE_INTERNAL_URL=http://webhook-queue:3333` via `docker-compose.yml`.

## Key Design Constraints

- **Atomic consume**: always use the prepared statements (`stmtClaimNext`, `stmtClaimByCorrelation`) for reads — never a SELECT followed by an UPDATE.
- **Correlation ID regex**: `^[A-Za-z0-9_-]{1,128}$` — validated in both `server.js` and `tools.ts` (Zod). Must stay in sync.
- **MCP tool responses**: use the `format()` helper in `tools.ts` — HTTP 4xx/5xx maps to `isError: true` in the MCP response.
- **Admin API `/by-id`**: defaults `peek=true` (non-destructive), unlike the queue's `/by-id` which defaults to claim. This asymmetry is intentional (admin UI reads should not consume).
- **Admin API `/peek`**: forwards `?limit`/`?offset` to the queue; use `stats.total` from the response to determine if more pages exist.
- **`DELETE /message/:id`**: uses `stmtDeleteById` prepared statement; returns 404 if the UUID doesn't match any row.
