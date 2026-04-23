# API Reference — Webhook Queue

Document de référence technique pour intégrer un producteur (n8n, script, application) ou un consommateur (Cowork, worker, LLM) à la webhook queue.

Pensé pour être consommé tel quel par un humain **ou** un LLM : chaque endpoint est documenté avec trois formats d'exemples (curl, JSON brut, Python), tous les codes de retour, et les règles strictes d'utilisation.

---

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Authentification](#2-authentification)
3. [Format des données](#3-format-des-données)
4. [Endpoints](#4-endpoints)
   - 4.1 [`POST /webhook`](#41-post-webhook)
   - 4.2 [`GET /next`](#42-get-next)
   - 4.3 [`GET /by-id/:correlation_id`](#43-get-by-idcorrelation_id)
   - 4.4 [`GET /peek`](#44-get-peek)
   - 4.5 [`GET /status`](#45-get-status)
   - 4.6 [`GET /stats`](#46-get-stats)
   - 4.7 [`DELETE /clear`](#47-delete-clear)
5. [Matrice globale des codes d'erreur](#5-matrice-globale-des-codes-derreur)
6. [Règles d'utilisation pour un LLM ou un script](#6-règles-dutilisation-pour-un-llm-ou-un-script)
7. [Patterns d'usage](#7-patterns-dusage)
8. [Exemples Python autonomes](#8-exemples-python-autonomes)
9. [Annexes](#9-annexes)

---

## 1. Vue d'ensemble

**Ce que fait le service** : stockage temporaire fiable de messages JSON entre un producteur qui pousse (`POST /webhook`) et un consommateur qui dépile (`GET /next` ou `GET /by-id/:cid`). Persistance SQLite, TTL automatique 48 h, auth par secret partagé, HTTPS via Traefik + Let's Encrypt.

**Non-objectifs** : ce n'est ni un broker pub/sub (pas de broadcast), ni un bus d'événements à long terme, ni un système de file prioritaire. **Un message = un seul consommateur**.

### Flux typique

```
  ┌─ Producteur ─┐              ┌─── Queue ───┐              ┌─ Consommateur ─┐
  │   (n8n)      │              │  webhook-   │              │   (Cowork)     │
  │              │ POST /webhook │   queue     │              │                │
  │              │ ─────────────▶│  SQLite    │              │                │
  │              │    JSON       │   pending   │ GET /next    │                │
  │              │               │  ────────── │ ◀─────────── │                │
  │              │               │    read     │   JSON item  │                │
  └──────────────┘               └─────────────┘              └────────────────┘
```

### Concepts clés

| Concept            | Signification                                                                                              |
|--------------------|------------------------------------------------------------------------------------------------------------|
| **FIFO**           | `GET /next` renvoie toujours le **plus ancien** message encore `pending`.                                  |
| **claim destructif** | `GET /next` et `GET /by-id/:cid` (sans `?peek`) marquent le message comme `read` atomiquement.             |
| **peek**           | Lecture **non-destructive** : `GET /peek` (tous) ou `GET /by-id/:cid?peek=true` (un seul).                 |
| **correlation_id** | ID fourni par le producteur via header `x-correlation-id`. Permet la récupération ciblée (request-response). |
| **TTL**            | Messages supprimés définitivement après 48 h (configurable), qu'ils soient lus ou non.                     |

### Garanties

- **Atomicité** : `GET /next` et `GET /by-id/:cid` utilisent `UPDATE … RETURNING`. Deux consommateurs concurrents ne reçoivent **jamais** le même message.
- **Unicité du correlation_id** : si fourni, doit être unique dans toute la queue. Doublon → 409.
- **Persistance** : volume Docker → survit aux redémarrages du container.
- **Ordre** : garanti FIFO uniquement sur `GET /next`. `GET /by-id` est explicitement hors-ordre.

---

## 2. Authentification

### Mécanisme

Toutes les routes **sauf `GET /status`** exigent le header :

```
x-webhook-secret: <valeur>
```

La comparaison est faite en temps constant (`crypto.timingSafeEqual`) pour résister aux attaques de timing.

### Sans / avec mauvais secret

→ `401 Unauthorized`
```json
{ "ok": false, "error": "Unauthorized" }
```

### Où trouver le secret

Côté serveur, dans `/opt/webhook-queue/.env`, champ `WEBHOOK_SECRET`. À transmettre aux producteurs et consommateurs par canal sûr. Rotation : changer la valeur puis `docker compose up -d --force-recreate`.

### Exemples

#### curl
```bash
curl -H "x-webhook-secret: $WEBHOOK_SECRET" https://queue.igk-digital.cloud/stats
```

#### JSON brut
```
GET /stats HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>
Accept: application/json
```

#### Python
```python
import os, requests

SECRET = os.environ["WEBHOOK_SECRET"]
BASE   = os.environ.get("QUEUE_URL", "https://queue.igk-digital.cloud")

r = requests.get(f"{BASE}/stats", headers={"x-webhook-secret": SECRET}, timeout=10)
r.raise_for_status()
print(r.json())
```

---

## 3. Format des données

### En entrée (POST)
- `Content-Type: application/json` **obligatoire**
- Encodage : UTF-8
- Taille max du body : **1 MB** — au-delà → `413 Payload Too Large`
- Pas de validation de schéma : tu envoies ce que tu veux, tant que c'est du JSON valide.

### En sortie
- Toujours du JSON UTF-8 (`Content-Type: application/json`)
- Champ racine standard : `{ "ok": true }` en cas de succès, `{ "ok": false, "error": "<code>" }` en cas d'échec.

### Champs timestamps
Toutes les dates exposées par l'API sont au format **ISO 8601 UTC** avec millisecondes :
```
2026-04-23T10:27:56.829Z
```

### Champs standards d'un item

Quand un endpoint renvoie un message (via `/next`, `/by-id`, `/peek`), sa forme est :

| Champ              | Type                  | Présence                | Description                                          |
|--------------------|-----------------------|-------------------------|------------------------------------------------------|
| `id`               | string (UUID v4)      | toujours                | Identifiant serveur, généré par la queue             |
| `source`           | string                | toujours                | Valeur du header `x-source` à l'enqueue, défaut `"n8n"` |
| `correlation_id`   | string \| null        | toujours (null si absent) | Valeur du header `x-correlation-id` à l'enqueue     |
| `status`           | `"pending"` \| `"read"` | sur `/peek` et `/by-id?peek` uniquement | Statut actuel                        |
| `created_at`       | string ISO 8601       | toujours                | Date d'enqueue                                       |
| `read_at`          | string ISO 8601 \| null | toujours (null si pas lu) | Date du claim                                     |
| `delete_at`        | string ISO 8601       | sur claim uniquement    | Date prévue de suppression (created_at + TTL)        |
| `payload`          | any JSON              | toujours                | Le body JSON envoyé lors du `POST /webhook`          |

### Payload corrompu

Si, pour une raison très improbable (corruption disque), le payload stocké n'est plus un JSON valide, le serveur renvoie un objet :
```json
{ "__corrupted": true, "raw": "<payload brut>" }
```
À la place du `payload` original. Ne pas paniquer — le serveur ne crashe pas.

---

## 4. Endpoints

Tous les endpoints retournent du JSON. URL de base = `https://queue.igk-digital.cloud`.

---

### 4.1 `POST /webhook`

**Auth** : ✅ | **Rate limit** : **100 req/min/IP** | **Destructif** : n/a (écriture)

**Description** : empile un message dans la queue. Peut être appelé avec un `x-correlation-id` optionnel pour activer le pattern request-response.

#### Headers

| Nom                  | Obligatoire | Format                        | Exemple                      |
|----------------------|-------------|-------------------------------|------------------------------|
| `Content-Type`       | ✅          | `application/json`            | `application/json`           |
| `x-webhook-secret`   | ✅          | string                        | `<secret>`                   |
| `x-source`           | ❌          | string libre                  | `n8n-workflow-42`            |
| `x-correlation-id`   | ❌          | `^[A-Za-z0-9_-]{1,128}$`      | `query-42`, `uuid`, `task_1` |

#### Body
N'importe quel JSON valide, taille ≤ 1 MB.

#### Réponse succès `200`

```json
{
  "ok": true,
  "id": "4f8a1234-5678-4abc-9def-0123456789ab",
  "correlation_id": "query-42",
  "pending": 3
}
```

| Champ            | Description                                                              |
|------------------|--------------------------------------------------------------------------|
| `id`             | UUID v4 généré par le serveur — clé primaire interne                     |
| `correlation_id` | Echo du header `x-correlation-id`, ou `null` si non envoyé               |
| `pending`        | Nombre de messages `pending` dans la queue après insertion               |

#### Réponses d'erreur

| HTTP | `error`                      | Quand                                                                 |
|------|------------------------------|-----------------------------------------------------------------------|
| 400  | `invalid_correlation_id`     | Header fourni mais ne matche pas `^[A-Za-z0-9_-]{1,128}$`             |
| 401  | `Unauthorized`               | `x-webhook-secret` absent ou incorrect                                |
| 409  | `duplicate_correlation_id`   | Ce `correlation_id` est déjà présent dans la queue (même `read`)      |
| 413  | *(corps vide ou HTML)*       | Payload > 1 MB                                                        |
| 429  | `Too many requests`          | Dépassement 100 req/min sur cette IP                                  |

Body d'un `409` :
```json
{
  "ok": false,
  "error": "duplicate_correlation_id",
  "correlation_id": "query-42",
  "existing_id": "4f8a1234-5678-4abc-9def-0123456789ab"
}
```

#### Exemples

##### curl
```bash
# Sans correlation_id
curl -X POST https://queue.igk-digital.cloud/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-source: n8n-workflow-42" \
  -d '{"event":"report.ready","url":"https://..."}'

# Avec correlation_id (pattern request-response)
curl -X POST https://queue.igk-digital.cloud/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-correlation-id: query-42" \
  -d '{"result":"ok","data":{"rows":12}}'
```

##### JSON brut
```
POST /webhook HTTP/1.1
Host: queue.igk-digital.cloud
Content-Type: application/json
x-webhook-secret: <secret>
x-correlation-id: query-42

{"result":"ok","data":{"rows":12}}

---

HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "id": "4f8a1234-5678-4abc-9def-0123456789ab",
  "correlation_id": "query-42",
  "pending": 1
}
```

##### Python
```python
import os, requests

BASE   = os.environ.get("QUEUE_URL", "https://queue.igk-digital.cloud")
SECRET = os.environ["WEBHOOK_SECRET"]

def enqueue(payload: dict, *, correlation_id: str | None = None, source: str | None = None) -> dict:
    """Empile un message. Retourne le dict de réponse (id, correlation_id, pending).
    Lève requests.HTTPError en cas d'échec HTTP."""
    headers = {
        "Content-Type": "application/json",
        "x-webhook-secret": SECRET,
    }
    if correlation_id:
        headers["x-correlation-id"] = correlation_id
    if source:
        headers["x-source"] = source

    r = requests.post(f"{BASE}/webhook", headers=headers, json=payload, timeout=10)
    if r.status_code == 409:
        data = r.json()
        raise ValueError(f"Duplicate correlation_id: {data['correlation_id']} -> {data['existing_id']}")
    r.raise_for_status()
    return r.json()

# Usage
resp = enqueue({"event": "report.ready"}, correlation_id="query-42")
print(resp["id"], resp["pending"])
```

---

### 4.2 `GET /next`

**Auth** : ✅ | **Rate limit** : aucun côté serveur *(sois raisonnable — voir règles §6)* | **Destructif** : ✅

**Description** : dépile atomiquement le message `pending` le plus ancien (ordre FIFO). Bascule son statut à `read`. Le message reste archivé jusqu'à expiration TTL (48 h), puis est supprimé.

#### Headers
| Nom                  | Obligatoire | Format  |
|----------------------|-------------|---------|
| `x-webhook-secret`   | ✅          | string  |

Pas de body, pas de query params, pas de path params.

#### Réponse — queue vide `200`

```json
{ "ok": true, "empty": true, "item": null }
```

#### Réponse — message dépilé `200`

```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "4f8a1234-5678-4abc-9def-0123456789ab",
    "source": "n8n",
    "correlation_id": "query-42",
    "created_at": "2026-04-23T10:00:00.000Z",
    "read_at":    "2026-04-23T10:05:12.345Z",
    "delete_at":  "2026-04-25T10:05:12.345Z",
    "payload": { "event": "report.ready" }
  },
  "pending": 2
}
```

| Champ            | Description                                               |
|------------------|-----------------------------------------------------------|
| `empty`          | `false` si un message a été dépilé, `true` sinon          |
| `item.read_at`   | Timestamp du moment précis du claim                       |
| `item.delete_at` | Quand ce message sera supprimé physiquement (TTL)         |
| `pending`        | Nombre de messages `pending` restants après le dépilement |

#### Réponses d'erreur

| HTTP | Quand                              |
|------|------------------------------------|
| 401  | `x-webhook-secret` absent/incorrect |

#### Exemples

##### curl
```bash
curl https://queue.igk-digital.cloud/next \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

##### JSON brut
```
GET /next HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>

---

HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "empty": false,
  "item": { ... },
  "pending": 2
}
```

##### Python
```python
def consume_next() -> dict | None:
    """Dépile le prochain message. Retourne le dict item ou None si vide."""
    r = requests.get(f"{BASE}/next", headers={"x-webhook-secret": SECRET}, timeout=10)
    r.raise_for_status()
    data = r.json()
    return None if data["empty"] else data["item"]

msg = consume_next()
if msg:
    print(msg["id"], msg["payload"])
```

---

### 4.3 `GET /by-id/:correlation_id`

**Auth** : ✅ | **Rate limit** : aucun côté serveur | **Destructif** : ✅ par défaut, ❌ avec `?peek=true`

**Description** : récupère **un message précis** par son `correlation_id` (fourni à l'enqueue via le header `x-correlation-id`). Permet le pattern request-response sans consommer les autres messages de la queue.

Deux modes :
- **Claim** (défaut) : marque le message comme `read`, ne sera plus accessible via claim.
- **Peek** (`?peek=true`) : lecture non-destructive, renvoie le message quel que soit son statut.

#### Path param

| Nom              | Format                   | Exemple      |
|------------------|--------------------------|--------------|
| `correlation_id` | `^[A-Za-z0-9_-]{1,128}$` | `query-42`   |

#### Query param

| Nom    | Obligatoire | Valeurs              | Default  | Effet                      |
|--------|-------------|----------------------|----------|----------------------------|
| `peek` | ❌          | `true` \| `1` \| rien | absent   | Si présent → lecture non-destructive |

#### Headers
| Nom                  | Obligatoire |
|----------------------|-------------|
| `x-webhook-secret`   | ✅          |

#### Réponse — claim réussi `200`

```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "4f8a1234-...-uuid",
    "source": "n8n",
    "correlation_id": "query-42",
    "created_at": "2026-04-23T10:00:00.000Z",
    "read_at":    "2026-04-23T10:05:12.345Z",
    "delete_at":  "2026-04-25T10:05:12.345Z",
    "payload": { "...": "..." }
  },
  "pending": 1
}
```

#### Réponse — peek réussi `200`

```json
{
  "ok": true,
  "peek": true,
  "item": {
    "id": "4f8a...",
    "source": "n8n",
    "correlation_id": "query-42",
    "status": "pending",
    "created_at": "2026-04-23T10:00:00.000Z",
    "read_at": null,
    "payload": { "...": "..." }
  }
}
```

Le champ `status` est exposé en mode peek (vaut `"pending"` ou `"read"`) et absent en mode claim.

#### Réponses d'erreur

| HTTP | `error`                  | Body additionnel                      | Quand                                              |
|------|--------------------------|---------------------------------------|----------------------------------------------------|
| 400  | `invalid_correlation_id` | —                                     | Path param ne matche pas la regex                  |
| 401  | `Unauthorized`           | —                                     | Auth KO                                            |
| 404  | `not_found`              | `correlation_id`                      | Aucun message avec ce correlation_id               |
| 410  | `already_read`           | `correlation_id`, `id`, `read_at`     | Message existe mais déjà consommé (claim sans peek) |

Body `404` :
```json
{ "ok": false, "error": "not_found", "correlation_id": "query-42" }
```

Body `410` :
```json
{
  "ok": false,
  "error": "already_read",
  "correlation_id": "query-42",
  "id": "4f8a...",
  "read_at": "2026-04-23T10:05:12.345Z"
}
```

#### Exemples

##### curl
```bash
# Claim
curl https://queue.igk-digital.cloud/by-id/query-42 \
  -H "x-webhook-secret: $WEBHOOK_SECRET"

# Peek (non-destructif)
curl "https://queue.igk-digital.cloud/by-id/query-42?peek=true" \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

##### JSON brut
```
GET /by-id/query-42 HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>

---

HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "empty": false,
  "item": { ... },
  "pending": 1
}
```

```
GET /by-id/query-42?peek=true HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>

---

HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true,
  "peek": true,
  "item": { "...", "status": "pending", "read_at": null }
}
```

##### Python
```python
def fetch_by_id(cid: str, *, peek: bool = False) -> dict | None:
    """Récupère un message par correlation_id.
    - Si peek=False : claim destructif (le message bascule en 'read').
    - Si peek=True  : lecture non-destructive.
    Retours :
      - dict item      → trouvé
      - None           → 404 (pas encore arrivé)
    Lève :
      - AlreadyReadError → 410 (claim déjà fait par un précédent appel)
      - ValueError       → 400 (cid malformé)
    """
    params = {"peek": "true"} if peek else None
    r = requests.get(
        f"{BASE}/by-id/{cid}",
        headers={"x-webhook-secret": SECRET},
        params=params,
        timeout=10,
    )
    if r.status_code == 404:
        return None
    if r.status_code == 410:
        data = r.json()
        raise AlreadyReadError(f"Message {data['id']} already read at {data['read_at']}")
    if r.status_code == 400:
        raise ValueError(f"Invalid correlation_id: {cid}")
    r.raise_for_status()
    return r.json()["item"]

class AlreadyReadError(Exception):
    pass
```

---

### 4.4 `GET /peek`

**Auth** : ✅ | **Rate limit** : aucun côté serveur | **Destructif** : ❌

**Description** : liste les **50 messages les plus récents** (ordre `created_at DESC`), qu'ils soient `pending` ou `read`. Ne modifie rien.

Utile pour : inspection, debug, dashboard.

#### Réponse `200`

```json
{
  "ok": true,
  "stats": {
    "total": 3,
    "pending": 2,
    "read_count": 1
  },
  "items": [
    {
      "id": "c3...",
      "source": "n8n",
      "correlation_id": "query-43",
      "status": "pending",
      "created_at": "2026-04-23T10:10:00.000Z",
      "read_at": null,
      "payload": { "...": "..." }
    },
    {
      "id": "b2...",
      "source": "n8n",
      "correlation_id": null,
      "status": "pending",
      "created_at": "2026-04-23T10:05:00.000Z",
      "read_at": null,
      "payload": { "...": "..." }
    },
    {
      "id": "a1...",
      "source": "n8n",
      "correlation_id": "query-42",
      "status": "read",
      "created_at": "2026-04-23T10:00:00.000Z",
      "read_at": "2026-04-23T10:02:00.000Z",
      "payload": { "...": "..." }
    }
  ]
}
```

| Champ                  | Description                                                 |
|------------------------|-------------------------------------------------------------|
| `stats.total`          | Nombre total de messages en base (pending + read)           |
| `stats.pending`        | Messages encore à consommer                                 |
| `stats.read_count`     | Messages déjà consommés (archivés jusqu'au TTL)             |
| `items`                | Jusqu'à 50 items, triés du plus récent au plus ancien       |

#### Exemples

##### curl
```bash
curl https://queue.igk-digital.cloud/peek \
  -H "x-webhook-secret: $WEBHOOK_SECRET" | jq
```

##### JSON brut
```
GET /peek HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>
```

##### Python
```python
def peek() -> dict:
    r = requests.get(f"{BASE}/peek", headers={"x-webhook-secret": SECRET}, timeout=10)
    r.raise_for_status()
    return r.json()

snapshot = peek()
print(f"{snapshot['stats']['pending']} pending, {snapshot['stats']['read_count']} read")
for it in snapshot["items"][:5]:
    print(" -", it["id"], it["status"], it["correlation_id"])
```

---

### 4.5 `GET /status`

**Auth** : ❌ (public) | **Rate limit** : aucun | **Destructif** : ❌

**Description** : health check minimaliste, sans auth, utilisé par Traefik et pour les pings externes. **Ne divulgue pas** la charge de la queue ni la version.

#### Réponse `200`

```json
{ "ok": true, "uptime_s": 3456 }
```

#### Exemples

##### curl
```bash
curl https://queue.igk-digital.cloud/status
```

##### JSON brut
```
GET /status HTTP/1.1
Host: queue.igk-digital.cloud

---

HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true, "uptime_s": 3456 }
```

##### Python
```python
def is_up() -> bool:
    try:
        r = requests.get(f"{BASE}/status", timeout=5)
        return r.ok and r.json().get("ok") is True
    except requests.RequestException:
        return False
```

---

### 4.6 `GET /stats`

**Auth** : ✅ | **Rate limit** : aucun | **Destructif** : ❌

**Description** : statistiques internes derrière l'auth. Utile pour un dashboard privé.

#### Réponse `200`

```json
{
  "ok": true,
  "uptime_s": 3456,
  "ttl_hours": 48,
  "cleanup_interval_min": 60,
  "stats": {
    "total": 12,
    "pending": 3,
    "read_count": 9
  }
}
```

#### Exemples

##### curl
```bash
curl https://queue.igk-digital.cloud/stats \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

##### JSON brut
```
GET /stats HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>
```

##### Python
```python
def queue_stats() -> dict:
    r = requests.get(f"{BASE}/stats", headers={"x-webhook-secret": SECRET}, timeout=10)
    r.raise_for_status()
    return r.json()

s = queue_stats()
print(f"{s['stats']['pending']} pending | TTL {s['ttl_hours']}h | uptime {s['uptime_s']}s")
```

---

### 4.7 `DELETE /clear`

**Auth** : ✅ | **Rate limit** : aucun | **Destructif** : ✅✅ (efface **tout**)

**Description** : purge totale de la queue. **Irréversible**. Réservé au debug.

#### Réponse `200`
```json
{ "ok": true }
```

#### Exemples

##### curl
```bash
curl -X DELETE https://queue.igk-digital.cloud/clear \
  -H "x-webhook-secret: $WEBHOOK_SECRET"
```

##### JSON brut
```
DELETE /clear HTTP/1.1
Host: queue.igk-digital.cloud
x-webhook-secret: <secret>
```

##### Python
```python
def clear_all():
    r = requests.delete(f"{BASE}/clear", headers={"x-webhook-secret": SECRET}, timeout=10)
    r.raise_for_status()
```

---

## 5. Matrice globale des codes d'erreur

| HTTP | Endpoint(s) concerné(s)      | Signification                                                    | Action recommandée                                          |
|------|------------------------------|------------------------------------------------------------------|-------------------------------------------------------------|
| 200  | tous                         | OK                                                               | —                                                           |
| 400  | `POST /webhook`, `GET /by-id`| `correlation_id` malformé                                        | Corriger l'ID (regex `^[A-Za-z0-9_-]{1,128}$`)              |
| 401  | tous sauf `/status`          | Auth absent ou incorrect                                         | Vérifier `x-webhook-secret`                                 |
| 404  | `GET /by-id/:cid`            | Pas de message avec ce `correlation_id`                          | Retry plus tard (le producteur n'a peut-être pas fini)      |
| 409  | `POST /webhook`              | `correlation_id` déjà utilisé                                    | Tu as déjà posté ce résultat — ne pas renvoyer              |
| 410  | `GET /by-id/:cid` (claim)    | Message déjà consommé                                            | Tu l'as déjà lu — réutiliser la donnée stockée localement   |
| 413  | `POST /webhook`              | Payload > 1 MB                                                   | Réduire le payload ou héberger les données ailleurs + lien  |
| 429  | `POST /webhook`              | > 100 req/min/IP                                                 | Backoff 60 s avant retry                                    |
| 500  | tous                         | Erreur serveur                                                   | Backoff exponentiel + vérifier les logs (`docker logs`)     |

---

## 6. Règles d'utilisation pour un LLM ou un script

### À FAIRE systématiquement

1. **Toujours** envoyer `Content-Type: application/json` sur `POST /webhook`.
2. **Toujours** envoyer le header `x-webhook-secret` sur toutes les routes sauf `/status`.
3. **Timeout** par défaut : 10 s sur les requêtes, 5 s sur `/status`.
4. **Gérer** explicitement les codes 401, 404, 409, 410, 429 — ils ont chacun une sémantique utile.
5. Stocker localement la réponse obtenue après un claim (`/next` ou `/by-id`) : en cas de retry, le serveur renverra 410 et tu n'auras plus accès au payload.

### À NE PAS FAIRE

- ❌ Ne pas faire de retry automatique sur 410 ou 409 — ce sont des erreurs **sémantiques**, pas transitoires.
- ❌ Ne pas faire de retry agressif sur 404 — si le message n'est pas encore là, poll toutes les 5-30 s, pas plus vite.
- ❌ Ne jamais loguer `x-webhook-secret` dans les traces ou les historiques LLM.
- ❌ Ne pas supposer qu'un `correlation_id` déjà utilisé peut être réutilisé après expiration TTL — la règle est stricte tant que la ligne existe. Utiliser un ID neuf à chaque requête.
- ❌ Ne pas appeler `DELETE /clear` en production — il efface **tout**, y compris les messages en attente.

### Backoff recommandé

| Code reçu | Stratégie                                                 |
|-----------|-----------------------------------------------------------|
| 429       | Attendre 60 s, puis retry 1x                              |
| 5xx       | Backoff exponentiel : 2s, 4s, 8s, 16s, puis abandonner    |
| 404 (poll)| 5-30 s entre les polls, plafonner à N=60 tentatives       |
| 401       | **Ne pas retry** — arrêter et signaler                    |
| 410       | **Ne pas retry** — utiliser la donnée déjà reçue          |

### Polling — cadences recommandées

| Cas                                    | Intervalle        |
|----------------------------------------|-------------------|
| Temps-réel (chat, notif)               | 2-5 s             |
| Tâches standards                       | 10-30 s           |
| Digest / batch                         | 60 s - 10 min     |
| Request-response (`/by-id/:cid`)       | 5 s, timeout 5-10 min |

---

## 7. Patterns d'usage

### 7.1 Pub/sub FIFO (producteur → consommateur)

```
  Producteur               Queue                Consommateur
  ──────────               ─────                ────────────
                                                  while True:
   POST /webhook ─────▶  [msg_A]                    msg = GET /next
   POST /webhook ─────▶  [msg_A, msg_B]              if msg:
                                                        process(msg)
                                                     else:
                                                        sleep(10)
```

Consommateur Python minimal :
```python
import time
while True:
    msg = consume_next()  # cf. §4.2
    if msg:
        handle(msg["payload"])
    else:
        time.sleep(10)
```

### 7.2 Request-response corrélé

```
  Cowork                      n8n                  Queue
  ──────                      ───                  ─────
  1. cid = uuid4()
  2. trigger_n8n(cid) ──────▶ process
                              4. POST /webhook
                                 x-correlation-id: cid ───▶ stored
  3. poll GET /by-id/<cid>
     (retries 404 → 200)
     ▲─────────────────────── read msg by cid ◀── UPDATE atomique
  5. done
```

Cowork Python :
```python
import uuid, time

def ask_n8n_and_wait(question: str, *, timeout_s: int = 300) -> dict:
    cid = str(uuid.uuid4())
    trigger_n8n_workflow(question=question, correlation_id=cid)  # ton implem

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            item = fetch_by_id(cid)   # cf. §4.3
        except AlreadyReadError:
            raise  # bug de ton code — déjà consommé avant ce point
        if item:
            return item["payload"]
        time.sleep(5)

    raise TimeoutError(f"Pas de réponse pour {cid} après {timeout_s}s")
```

### 7.3 Inspection / debug

```python
snapshot = peek()
print(f"{snapshot['stats']['pending']} pending")
for it in snapshot["items"]:
    age_s = (time.time() - iso_to_epoch(it["created_at"]))
    print(f" - {it['id'][:8]} {it['status']} age={age_s:.0f}s cid={it['correlation_id']}")
```

### 7.4 Broadcast — **impossible par design**

Un message = un seul consommateur. Si tu en veux plusieurs :
- duplique le `POST /webhook` avec un `correlation_id` différent pour chaque destinataire, ou
- colle un service de fan-out en amont (n8n "Multiple HTTP Request" node).

---

## 8. Exemples Python autonomes

Trois scripts prêts à exécuter. Config attendue en env :
```bash
export QUEUE_URL=https://queue.igk-digital.cloud
export WEBHOOK_SECRET=<ton-secret>
```

### 8.1 `producer.py` — envoie 3 messages (dont 2 corrélés)

```python
#!/usr/bin/env python3
"""producer.py — pousse 3 messages vers la queue."""
import os, sys, uuid, json, requests

BASE   = os.environ.get("QUEUE_URL", "https://queue.igk-digital.cloud")
SECRET = os.environ["WEBHOOK_SECRET"]

def post(payload, *, cid=None, source="demo"):
    h = {"Content-Type": "application/json",
         "x-webhook-secret": SECRET,
         "x-source": source}
    if cid:
        h["x-correlation-id"] = cid
    r = requests.post(f"{BASE}/webhook", headers=h, json=payload, timeout=10)
    r.raise_for_status()
    return r.json()

def main():
    # Message simple, sans corrélation
    r1 = post({"type": "heartbeat", "ts": "now"})
    print("Msg 1 (FIFO-only):", r1["id"], "pending:", r1["pending"])

    # Messages avec correlation_id — récupérables par ID par Cowork
    cid2 = f"demo-{uuid.uuid4()}"
    r2 = post({"type": "report", "week": 17}, cid=cid2)
    print("Msg 2 (cid):", r2["correlation_id"], "→", r2["id"])

    cid3 = f"demo-{uuid.uuid4()}"
    r3 = post({"type": "alert", "level": "warn"}, cid=cid3)
    print("Msg 3 (cid):", r3["correlation_id"], "→", r3["id"])

    print(f"\nTotal pending: {r3['pending']}")
    print(f"Pour récupérer par ID: GET /by-id/{cid2} et /by-id/{cid3}")

if __name__ == "__main__":
    main()
```

### 8.2 `consumer_fifo.py` — boucle de traitement FIFO

```python
#!/usr/bin/env python3
"""consumer_fifo.py — dépile en continu, FIFO."""
import os, sys, time, requests

BASE   = os.environ.get("QUEUE_URL", "https://queue.igk-digital.cloud")
SECRET = os.environ["WEBHOOK_SECRET"]
SLEEP  = int(os.environ.get("POLL_INTERVAL", "10"))

def consume_next():
    r = requests.get(f"{BASE}/next",
                     headers={"x-webhook-secret": SECRET},
                     timeout=10)
    if r.status_code == 401:
        raise SystemExit("401 — secret invalide, arrêt.")
    r.raise_for_status()
    data = r.json()
    return None if data["empty"] else data["item"]

def handle(item):
    """Ta logique métier. Ici on log juste."""
    print(f"[{item['created_at']}] {item['id'][:8]} cid={item['correlation_id']} "
          f"payload={item['payload']}")

def main():
    print(f"Polling {BASE}/next toutes les {SLEEP}s. Ctrl+C pour arrêter.")
    while True:
        try:
            msg = consume_next()
        except requests.RequestException as e:
            print(f"Erreur réseau : {e} — retry dans {SLEEP}s")
            time.sleep(SLEEP)
            continue

        if msg:
            handle(msg)
        else:
            time.sleep(SLEEP)

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\nArrêt demandé.")
```

### 8.3 `consumer_correlated.py` — attente du résultat d'un ID précis

```python
#!/usr/bin/env python3
"""consumer_correlated.py — attend le résultat d'une requête identifiée par correlation_id."""
import os, sys, time, argparse, requests

BASE   = os.environ.get("QUEUE_URL", "https://queue.igk-digital.cloud")
SECRET = os.environ["WEBHOOK_SECRET"]

class AlreadyReadError(Exception): pass

def fetch_by_id(cid, *, peek=False):
    """Récupère par correlation_id. Retour: dict item | None (404).
    Raise AlreadyReadError si 410."""
    params = {"peek": "true"} if peek else None
    r = requests.get(f"{BASE}/by-id/{cid}",
                     headers={"x-webhook-secret": SECRET},
                     params=params, timeout=10)
    if r.status_code == 404:
        return None
    if r.status_code == 410:
        raise AlreadyReadError(r.json())
    if r.status_code == 400:
        raise ValueError(f"correlation_id malformé: {cid}")
    r.raise_for_status()
    return r.json()["item"]

def wait_for_result(cid, *, timeout_s=300, poll_s=5):
    """Poll GET /by-id/<cid> jusqu'à obtenir un 200. Retourne le payload."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        item = fetch_by_id(cid)
        if item is not None:
            return item["payload"]
        time.sleep(poll_s)
    raise TimeoutError(f"Pas de message pour {cid} après {timeout_s}s")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("cid", help="correlation_id à attendre")
    p.add_argument("--timeout", type=int, default=300)
    p.add_argument("--poll",    type=int, default=5)
    p.add_argument("--peek",    action="store_true",
                   help="Juste regarder, sans consommer")
    a = p.parse_args()

    if a.peek:
        item = fetch_by_id(a.cid, peek=True)
        if item is None:
            print(f"404 — aucun message avec cid={a.cid}"); sys.exit(1)
        print(f"Status: {item['status']}")
        print(f"Payload: {item['payload']}")
        return

    try:
        payload = wait_for_result(a.cid, timeout_s=a.timeout, poll_s=a.poll)
        print(f"Reçu : {payload}")
    except AlreadyReadError as e:
        print(f"410 — déjà consommé: {e}"); sys.exit(2)
    except TimeoutError as e:
        print(f"Timeout: {e}"); sys.exit(3)

if __name__ == "__main__":
    main()
```

Usage :
```bash
# Attendre jusqu'à 5 min le résultat de la requête "query-42"
python3 consumer_correlated.py query-42 --timeout 300 --poll 5

# Juste vérifier sans consommer
python3 consumer_correlated.py query-42 --peek
```

---

## 9. Annexes

### 9.1 Variables d'environnement côté serveur

| Variable                | Défaut              | Rôle                                          |
|-------------------------|---------------------|-----------------------------------------------|
| `DOMAIN`                | —                   | Domaine public (ex : `queue.igk-digital.cloud`) |
| `WEBHOOK_SECRET`        | — *(obligatoire)*   | Secret partagé, 32+ caractères                |
| `PORT`                  | `3333`              | Port HTTP interne du container                |
| `DB_PATH`               | `/data/queue.db`    | Chemin SQLite dans le volume                  |
| `TTL_HOURS`             | `48`                | Rétention des messages (lus et non-lus)       |
| `CLEANUP_INTERVAL_MIN`  | `60`                | Fréquence du cleanup automatique              |
| `NODE_ENV`              | `production`        | En prod → fail-fast si secret absent          |

### 9.2 Schéma SQLite

```sql
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,                   -- UUID v4 serveur
  source          TEXT NOT NULL DEFAULT 'n8n',        -- header x-source
  payload         TEXT NOT NULL,                      -- JSON stringifié
  status          TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'read'
  created_at      INTEGER NOT NULL,                   -- epoch ms
  read_at         INTEGER,                            -- epoch ms | NULL
  correlation_id  TEXT                                -- header x-correlation-id | NULL
);

CREATE INDEX idx_status     ON messages(status);
CREATE INDEX idx_created_at ON messages(created_at);
CREATE INDEX idx_read_at    ON messages(read_at);
CREATE UNIQUE INDEX idx_correlation_id_unique
  ON messages(correlation_id) WHERE correlation_id IS NOT NULL;
```

### 9.3 Limites connues

| Limite                                                         | Valeur       |
|----------------------------------------------------------------|--------------|
| Taille max d'un payload POST                                   | 1 MB         |
| Rate limit `POST /webhook` par IP                              | 100 req/min  |
| Rate limit autres endpoints                                    | aucun        |
| Rétention TTL                                                  | 48 h         |
| Nombre d'items retournés par `/peek`                           | 50           |
| Longueur de `correlation_id`                                   | 1-128 chars  |
| Caractères autorisés dans `correlation_id`                     | `[A-Za-z0-9_-]` |

### 9.4 Checklist d'intégration

- [ ] Obtenu `WEBHOOK_SECRET` et `QUEUE_URL` par canal sûr
- [ ] `/status` répond 200 → le service est joignable
- [ ] Test `POST /webhook` + `GET /next` → round-trip OK
- [ ] Test `POST` avec `x-correlation-id` + `GET /by-id` → récupération ciblée OK
- [ ] Timeout HTTP configuré (10 s)
- [ ] Gestion explicite des codes 401, 404, 409, 410, 429
- [ ] Retries seulement sur 5xx et 429 (pas sur 401/404/409/410)
- [ ] Secret JAMAIS loggé ni exposé côté client

### 9.5 Contact

- Code source : `/opt/webhook-queue/` sur le VPS de prod
- Logs : `docker logs webhook-queue` ou `docker compose logs -f` depuis `/opt/webhook-queue/`
- Désinstallation propre : `cd /opt/webhook-queue && ./uninstall.sh --yes`
