# Webhook Queue

File d'attente HTTP durable, auto-hébergée, pour découpler un **producteur** (ex : `n8n`) d'un **consommateur** (ex : une instance `Cowork`) quand le consommateur n'est pas toujours joignable.

- **Stockage** : SQLite persistant (volume Docker)
- **Auto-nettoyage** : TTL configurable (48 h par défaut)
- **Transport** : HTTPS via Traefik + Let's Encrypt
- **Auth** : secret partagé dans un header HTTP
- **Rate limiting** : 100 req/min par IP sur `/webhook`

---

## Sommaire

1. [Installation](#installation)
2. [Référence API HTTP](#référence-api-http)
3. [Authentification](#authentification)
4. [Exemples `curl`](#exemples-curl)
5. [Intégration n8n (producteur)](#intégration-n8n-producteur)
6. [Intégration consommateur (Cowork, script, etc.)](#intégration-consommateur)
7. [Codes d'erreur](#codes-derreur)
8. [Sécurité](#sécurité)
9. [MCP Server — accès depuis Claude](#mcp-server--accès-depuis-claude)
10. [Désinstallation](#désinstallation)

---

## Installation

```bash
./install.sh
```

Le script interactif :
- Vérifie Docker / Docker Compose v2 / openssl
- Demande le sous-domaine + domaine racine
- Demande le sous-domaine MCP (défaut : `mcp.<domaine-racine>`)
- Génère un `WEBHOOK_SECRET` (64 caractères hex) et un `MCP_TOKEN` (32 caractères hex)
- Écrit un `.env` (chmod 600)
- Crée le réseau `traefik_proxy` au besoin
- Lance `docker compose up -d --build`

**Pré-requis côté serveur** :
- Traefik actif sur le réseau `traefik_proxy` avec entrypoint `websecure` et certresolver `letsencrypt`
- DNS du domaine pointant sur l'IP du serveur
- Port 443 ouvert

---

## Référence API HTTP

Toutes les routes renvoient du JSON. URL de base = `https://<ton-domaine>`.

| Méthode | Endpoint                   | Auth | Rôle                                                       |
|---------|----------------------------|------|------------------------------------------------------------|
| `POST`  | `/webhook`                 | ✅   | **Producteur** — empile un message                         |
| `GET`   | `/next`                    | ✅   | **Consommateur FIFO** — dépile le plus ancien              |
| `GET`   | `/by-id/:correlation_id`   | ✅   | **Consommateur ciblé** — dépile un message précis par ID   |
| `GET`   | `/peek`                    | ✅   | Inspection — 50 derniers, sans toucher                     |
| `GET`   | `/status`                  | ❌   | Health check (public, minimal)                             |
| `GET`   | `/stats`                   | ✅   | Stats détaillées                                           |
| `DELETE`| `/clear`                   | ✅   | Purge totale (debug)                                       |

### `POST /webhook`

Empile un message dans la queue.

**Headers**
```
Content-Type: application/json
x-webhook-secret: <ton_secret>
x-source: <identifiant_du_producteur>   # optionnel, défaut: "n8n"
x-correlation-id: <id_unique>           # optionnel — pour le pattern request-response
```

- `x-correlation-id` : chaîne arbitraire, regex `^[A-Za-z0-9_-]{1,128}$`. Si fournie, elle doit être **unique** dans toute la queue. Permet ensuite de récupérer ce message précis via `GET /by-id/<cet id>`.

**Body** : n'importe quel JSON (`< 1 MB`).

**Réponse `200`**
```json
{
  "ok": true,
  "id": "4f8a…-uuid",
  "correlation_id": "query-42",
  "pending": 3
}
```
`correlation_id` vaut `null` si le header n'a pas été envoyé.

**Réponse `400` — correlation_id malformé**
```json
{ "ok": false, "error": "invalid_correlation_id",
  "hint": "Format attendu : ^[A-Za-z0-9_-]{1,128}$" }
```

**Réponse `409` — correlation_id déjà utilisé**
```json
{ "ok": false, "error": "duplicate_correlation_id",
  "correlation_id": "query-42",
  "existing_id": "4f8a…-uuid" }
```

### `GET /next`

Dépile **atomiquement** le message le plus ancien (FIFO) et le marque comme lu. Supprimé physiquement après `TTL_HOURS`.

> Atomique = deux consommateurs parallèles reçoivent **deux messages différents**, jamais le même (géré par `UPDATE … RETURNING` en SQLite).

**Réponse si queue vide**
```json
{ "ok": true, "empty": true, "item": null }
```

**Réponse avec message**
```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "4f8a…-uuid",
    "source": "n8n",
    "correlation_id": "query-42",
    "created_at": "2026-04-19T10:00:00.000Z",
    "read_at":    "2026-04-19T10:05:12.345Z",
    "delete_at":  "2026-04-21T10:05:12.345Z",
    "payload": { /* ton JSON original */ }
  },
  "pending": 2
}
```
`correlation_id` est `null` si le producteur n'en a pas envoyé.

### `GET /by-id/:correlation_id`

Récupère un message **précis** par son correlation ID (fourni à l'origine dans le header `x-correlation-id` du `POST /webhook`). Complète le mode FIFO de `/next` — ne consomme pas les autres messages de la queue.

**Query params**
- `?peek=true` → lecture **non-destructive**, renvoie le message quel que soit son statut (pending ou read).
- Sans paramètre → **claim destructif** (atomique) : bascule le message `pending → read`, renverra 410 au prochain appel.

**Réponse `200` (claim)**
```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "4f8a…-uuid",
    "source": "n8n",
    "correlation_id": "query-42",
    "created_at": "2026-04-19T10:00:00.000Z",
    "read_at":    "2026-04-19T10:05:12.345Z",
    "delete_at":  "2026-04-21T10:05:12.345Z",
    "payload": { /* ton JSON original */ }
  },
  "pending": 1
}
```

**Réponse `200` (peek)**
```json
{
  "ok": true,
  "peek": true,
  "item": {
    "id": "4f8a…-uuid",
    "source": "n8n",
    "correlation_id": "query-42",
    "status": "pending",
    "created_at": "2026-04-19T10:00:00.000Z",
    "read_at": null,
    "payload": { /* … */ }
  }
}
```

**Erreurs**
| Code | Signification |
|------|---------------|
| `400` | `:correlation_id` ne matche pas la regex |
| `401` | Auth échouée |
| `404` | Aucun message avec ce correlation_id |
| `410` | Message déjà lu (seulement en mode claim, pas en peek) |

### `GET /peek`

Renvoie les 50 derniers messages (lus + pending) **sans les dépiler**.

```json
{
  "ok": true,
  "stats": { "total": 3, "pending": 2, "read_count": 1 },
  "items": [ /* jusqu'à 50 items, plus récents d'abord */ ]
}
```

### `GET /status`

Health check **public** (utilisé par Traefik). Volontairement minimal — ne divulgue pas la charge de la queue.

```json
{ "ok": true, "uptime_s": 3456 }
```

### `GET /stats`

Version authentifiée avec détails internes.

```json
{
  "ok": true,
  "uptime_s": 3456,
  "ttl_hours": 48,
  "cleanup_interval_min": 60,
  "stats": { "total": 3, "pending": 2, "read_count": 1 }
}
```

### `DELETE /clear`

Supprime **tous** les messages. À utiliser uniquement pour debug/reset.

```json
{ "ok": true }
```

---

## Authentification

Toutes les routes sauf `/status` exigent le header :

```
x-webhook-secret: <valeur du WEBHOOK_SECRET dans le .env>
```

Comparaison **à temps constant** (`crypto.timingSafeEqual`) pour résister aux attaques de timing.

Sans header ou avec une valeur incorrecte → `401 Unauthorized`.

---

## Exemples `curl`

Variables à exporter :
```bash
export QUEUE_URL="https://queue.igk-digital.cloud"
export WEBHOOK_SECRET="<ton_secret>"
```

### Empiler un message
```bash
curl -X POST "$QUEUE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-source: n8n-workflow-42" \
  -d '{"event":"report.ready","url":"https://..."}'
```

### Empiler avec un correlation ID (pattern request-response)
```bash
curl -X POST "$QUEUE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-correlation-id: query-42" \
  -d '{"result":"..."}'
```

### Dépiler un message (FIFO)
```bash
curl "$QUEUE_URL/next" \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

### Récupérer un message par son correlation ID (claim destructif)
```bash
curl "$QUEUE_URL/by-id/query-42" \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

### Lire un message par correlation ID sans le consommer (peek)
```bash
curl "$QUEUE_URL/by-id/query-42?peek=true" \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

### Inspecter sans toucher
```bash
curl "$QUEUE_URL/peek" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" | jq
```

### Health check public
```bash
curl "$QUEUE_URL/status"
```

### Vider la queue
```bash
curl -X DELETE "$QUEUE_URL/clear" \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

---

## Intégration n8n (producteur)

Dans ton workflow n8n, ajoute un node **HTTP Request** en fin de chaîne :

| Champ            | Valeur                                  |
|------------------|-----------------------------------------|
| Method           | `POST`                                  |
| URL              | `https://<ton-domaine>/webhook`         |
| Authentication   | Generic Credential → *Header Auth*      |
| Header name      | `x-webhook-secret`                      |
| Header value     | *(ton secret, stocké en credential)*    |
| Send Body        | `JSON` — ton payload                    |

Optionnel : ajouter un header `x-source: <nom_workflow>` pour tracer l'origine dans les logs côté queue.

> 💡 Le node HTTP Request n8n a un toggle "Response → Ignore Response" que tu peux laisser actif : la queue répond vite, pas besoin de bloquer ton workflow.

---

## Intégration consommateur

### Option 1 — Script shell fourni (`poll.sh`)

```bash
export QUEUE_URL="https://queue.igk-digital.cloud"
export WEBHOOK_SECRET="<ton_secret>"

./poll.sh next           # dépile 1 message
./poll.sh peek           # liste sans toucher
./poll.sh wait 5         # bloque jusqu'à un message (poll toutes les 5s)
./poll.sh all            # dépile tout en rafale
```

### Option 2 — Boucle de polling simple (bash)

```bash
while true; do
  RESP=$(curl -sf "$QUEUE_URL/next" -H "x-webhook-secret: $WEBHOOK_SECRET")
  EMPTY=$(echo "$RESP" | jq -r '.empty')
  if [ "$EMPTY" = "false" ]; then
    echo "$RESP" | jq '.item.payload' | /usr/local/bin/handle-message.sh
  else
    sleep 10
  fi
done
```

### Option 3 — Node.js

```js
async function consumeNext() {
  const res = await fetch(`${process.env.QUEUE_URL}/next`, {
    headers: { 'x-webhook-secret': process.env.WEBHOOK_SECRET }
  })
  const data = await res.json()
  if (data.empty) return null
  return data.item  // { id, source, created_at, payload, … }
}

// Polling loop
setInterval(async () => {
  const item = await consumeNext()
  if (item) await handle(item.payload)
}, 10_000)
```

### Option 4 — Python

```python
import os, time, requests

QUEUE = os.environ["QUEUE_URL"]
SECRET = os.environ["WEBHOOK_SECRET"]
H = {"x-webhook-secret": SECRET}

while True:
    r = requests.get(f"{QUEUE}/next", headers=H, timeout=10)
    r.raise_for_status()
    data = r.json()
    if not data["empty"]:
        handle(data["item"]["payload"])
    else:
        time.sleep(10)
```

### Cadence de polling conseillée

| Besoin                          | Intervalle recommandé |
|----------------------------------|-----------------------|
| Temps réel (chat, notifs)       | 2–5 s                 |
| Traitement de tâches standard   | 10–30 s               |
| Digest / batch quotidien        | 1–10 min              |

> 🔢 Limite : 100 requêtes/minute/IP sur `/webhook`. `/next` n'est pas rate-limité côté application, mais reste raisonnable — un poll toutes les secondes est overkill.

---

## Codes d'erreur

| Code  | Cause                                                     |
|-------|-----------------------------------------------------------|
| `200` | OK                                                        |
| `400` | `x-correlation-id` ou `/by-id/:cid` malformé              |
| `401` | `x-webhook-secret` absent ou incorrect                    |
| `404` | `/by-id/:cid` — aucun message avec ce correlation_id      |
| `409` | `POST /webhook` — correlation_id déjà utilisé             |
| `410` | `/by-id/:cid` — message déjà consommé (sans `?peek=true`) |
| `413` | Payload `POST /webhook` > 1 MB                            |
| `429` | Rate limit (>100 req/min/IP sur `/webhook`)               |
| `500` | Erreur serveur (voir `docker compose logs`)               |

---

## Sécurité

- **Fail-fast** : le serveur refuse de démarrer en production sans `WEBHOOK_SECRET`.
- **Comparaison à temps constant** du secret (`crypto.timingSafeEqual`).
- **Rate limiting** sur `/webhook` pour éviter la saturation du disque en cas de fuite du secret.
- **Utilisateur non-root** dans le container.
- **Trust proxy** = 1 pour obtenir la vraie IP client derrière Traefik (pour le rate limiter).
- **`/status` public mais minimal** : `{ok, uptime_s}` uniquement — la charge de la queue reste privée.
- **Rotation du secret** : modifier `WEBHOOK_SECRET` dans `.env` puis `docker compose up -d --force-recreate`. Pense à mettre à jour les producteurs/consommateurs en même temps.

---

## MCP Server — accès depuis Claude

Le serveur MCP (Model Context Protocol) permet à Claude Desktop, Claude Web et Claude Mobile de lire la queue et d'y envoyer des messages **directement depuis une conversation**, sans écrire une ligne de code. Il suffit de connecter l'URL MCP dans les paramètres de Claude — les tools deviennent alors disponibles comme des capacités natives.

### Architecture

```
Claude (desktop / web / mobile)
        │  HTTPS + MCP token
        ▼
┌───────────────────┐
│  cowork-mcp       │  service Docker, sous-domaine mcp.<DOMAIN>
│  (MCP server)     │
└────────┬──────────┘
         │  HTTP interne (WEBHOOK_SECRET)
         ▼
┌───────────────────┐
│  cowork-queue     │  file d'attente SQLite
└────────┬──────────┘
         │  POST /webhook  (n8n la produit / la consomme)
         ▼
┌───────────────────┐
│       n8n         │  producteur & consommateur métier
└───────────────────┘
```

### Installation

Le script `install.sh` s'en occupe automatiquement : il demande le sous-domaine MCP, génère un `MCP_TOKEN` aléatoire (32 caractères hex), et les écrit dans le `.env`.

**Pré-requis DNS** : créer un record **A** pour `mcp.<DOMAIN>` pointant vers l'IP de ton VPS (distinct du record `queue.<DOMAIN>`).

### Configuration côté Claude

1. Ouvrir **Paramètres → Connecteurs → Ajouter un connecteur personnalisé**
2. Renseigner :
   - **Nom** : `Cowork Queue` (ou tout autre nom)
   - **URL** : `https://mcp.<DOMAIN>/t/<MCP_TOKEN>/mcp`
3. Sauvegarder — les tools apparaissent immédiatement dans Claude.

Le `MCP_TOKEN` se trouve dans le fichier `.env` du VPS, ligne `MCP_TOKEN=...`.

### Tools disponibles

| Tool | Effet |
|------|-------|
| `queue_status` | Health check du serveur. |
| `queue_stats` | Compteurs pending/read, uptime, TTL. |
| `queue_peek` | Voir 50 derniers messages sans consommer. |
| `queue_next` | Dépile FIFO (destructif). |
| `queue_by_id` | Récupère par correlation_id (peek ou claim). |
| `queue_send` | Poste un message (déclenche n8n). |

### Rotation du token

Pour révoquer un token compromis ou faire une rotation régulière :

```bash
# Sur le VPS
nano .env              # modifier MCP_TOKEN=<nouveau_token>
docker compose up -d cowork-mcp
```

Puis mettre à jour l'URL dans Claude : **Paramètres → Connecteurs** → éditer l'URL avec le nouveau token.

### Sécurité

- Le token est embarqué dans l'URL (`/t/<token>/mcp`) et vérifié en **timing-safe** côté serveur.
- Un token invalide renvoie `404` (pas de fuite d'information sur l'existence du endpoint).
- Le transport est chiffré via **Traefik + Let's Encrypt** (TLS automatique).
- Voir [`mcp/README.md`](mcp/README.md) pour les détails techniques d'implémentation.

---

## Désinstallation

```bash
./uninstall.sh          # interactif
./uninstall.sh --yes    # non-interactif (tout supprime)
```

Retire le container, le volume (= toutes les données SQLite), l'image Docker, le `.env`, et si plus rien ne l'utilise, le réseau `traefik_proxy`.

---

## Configuration (`.env`)

| Variable                | Défaut            | Rôle                                     |
|-------------------------|-------------------|------------------------------------------|
| `DOMAIN`                | —                 | Domaine public (ex : `queue.example.com`)|
| `WEBHOOK_SECRET`        | —                 | Secret partagé (obligatoire en prod)     |
| `PORT`                  | `3333`            | Port interne du container                |
| `DB_PATH`               | `/data/queue.db`  | Chemin SQLite (dans le volume)           |
| `TTL_HOURS`             | `48`              | Rétention des messages                   |
| `CLEANUP_INTERVAL_MIN`  | `60`              | Fréquence du cleanup auto                |
| `MCP_DOMAIN`            | —                 | Sous-domaine du serveur MCP (ex : `mcp.example.com`) |
| `MCP_TOKEN`             | —                 | Token d'accès MCP (32 caractères hex, dans l'URL) |
