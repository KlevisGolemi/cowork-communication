# Instructions pour Cowork — Récupérer les messages de la queue

Ce document contient des **prompts prêts à copier-coller** à destination de l'instance Cowork (ou de n'importe quel consommateur) pour qu'elle sache comment interroger la webhook queue.

---

## Sommaire

1. [Variables à transmettre à Cowork](#1-variables-à-transmettre-à-cowork)
2. [Prompt one-shot — "récupère le prochain message"](#2-prompt-one-shot)
3. [Prompt avec boucle d'attente](#3-prompt-avec-boucle-dattente)
4. [Prompt — traiter toute la queue](#4-prompt--traiter-toute-la-queue)
5. [Prompt — vérifier l'état sans consommer](#5-prompt--vérifier-létat-sans-consommer)
6. [Pattern request-response par correlation ID](#6-pattern-request-response-par-correlation-id) ⭐
7. [Template de system prompt permanent](#7-template-de-system-prompt-permanent)
8. [Mémo : format du message reçu](#8-mémo--format-du-message-reçu)

---

## 1. Variables à transmettre à Cowork

Avant n'importe quel prompt, Cowork doit connaître :

```
QUEUE_URL=https://queue.igk-digital.cloud
WEBHOOK_SECRET=<ton_secret_64_hex>
```

Deux options pour les fournir :

**A. Variables d'environnement sur la machine de Cowork**
```bash
export QUEUE_URL="https://queue.igk-digital.cloud"
export WEBHOOK_SECRET="<ton_secret>"
```

**B. Inline dans le prompt** (moins propre — le secret traîne dans l'historique) :
> *"La queue est à `https://queue.igk-digital.cloud`, le secret est `<ton_secret>`"*

→ Préfère **A** pour éviter de loguer le secret dans les conversations.

---

## 2. Prompt one-shot

Pour récupérer **un seul** message disponible et le traiter.

```
Récupère le prochain message de la webhook queue et traite son payload.

URL de la queue : $QUEUE_URL (ou https://queue.igk-digital.cloud)
Authentification : header `x-webhook-secret` avec la valeur de $WEBHOOK_SECRET

Étapes :
1. Lance :
     curl -sf "$QUEUE_URL/next" -H "x-webhook-secret: $WEBHOOK_SECRET"
2. Parse le JSON renvoyé.
3. Si `empty: true` → affiche "Queue vide, rien à faire" et stoppe.
4. Sinon, extrait `item.payload` et traite-le selon son contenu (le payload
   est le JSON original envoyé par n8n).
5. Confirme avec l'id (`item.id`) ce qui a été consommé.

Important :
- `GET /next` DÉPILE le message (il ne sera plus disponible après).
- Le message reste archivé côté serveur pendant 48h (statut "read") puis
  est supprimé automatiquement.
```

---

## 3. Prompt avec boucle d'attente

Pour **attendre** un message qui n'est pas encore arrivé.

```
Surveille la webhook queue et traite le premier message qui arrive.

URL : $QUEUE_URL   |   Header auth : x-webhook-secret = $WEBHOOK_SECRET

Boucle :
1. GET $QUEUE_URL/next avec le header d'auth.
2. Si `empty: true` → attends 10 secondes puis réessaie.
3. Sinon → extrait `item.payload`, traite-le, puis arrête la boucle.

Limites :
- N'exécute pas plus de 60 itérations (≈ 10 minutes) avant de demander
  s'il faut continuer.
- Si le serveur renvoie 401 → alerte, c'est un problème d'auth.
- Si le serveur renvoie 5xx → retry avec backoff (10s, 20s, 40s, puis abandon).
```

---

## 4. Prompt — traiter toute la queue

Pour rattraper un backlog accumulé.

```
Vide la webhook queue en traitant chaque message un par un.

URL : $QUEUE_URL   |   Auth : x-webhook-secret = $WEBHOOK_SECRET

Répète :
1. GET $QUEUE_URL/next
2. Si `empty: true` → termine la boucle, affiche le total consommé.
3. Sinon → traite `item.payload`, note l'id traité, continue.

À la fin, récapitule :
- Nombre total de messages consommés
- Liste des ids traités
- Éventuels ids qui ont échoué (et pourquoi)

Sécurité : bloque la boucle à 100 messages max, puis demande confirmation
avant de continuer (évite une fuite de boucle infinie).
```

---

## 5. Prompt — vérifier l'état sans consommer

Pour inspecter ce qu'il y a dans la queue **sans dépiler**.

```
Liste ce qui est actuellement dans la webhook queue sans rien consommer.

URL : $QUEUE_URL   |   Auth : x-webhook-secret = $WEBHOOK_SECRET

Commande :
  curl -sf "$QUEUE_URL/peek" -H "x-webhook-secret: $WEBHOOK_SECRET"

Présente :
- `stats.pending` : messages pas encore lus
- `stats.read_count` : déjà lus (encore archivés < 48h)
- `stats.total`
- Les 5 messages les plus récents avec id, source, status, created_at,
  et un résumé d'une ligne du payload.
```

---

## 6. Pattern request-response par correlation ID

Quand Cowork **émet une demande** à n8n (avec un ID unique) et veut **récupérer la réponse de cette requête précise** — sans consommer les autres messages de la queue — c'est ce pattern qu'il faut utiliser.

### Flux complet

```
  ┌─ Cowork ─┐     1. génère un ID unique (UUID)                ┌─ n8n ─┐
  │          │ ─ 2. déclenche workflow avec cet ID ───────────▶ │       │
  │          │                                                   │  …    │
  │          │ ◀─ 3. n8n POST /webhook + x-correlation-id=<ID> ─ │       │
  │          │                                                   └───────┘
  │          │ 4. GET /by-id/<ID> → récupère SA réponse
  └──────────┘
```

### Prompt à coller dans Cowork pour ce pattern

```
Tu vas déclencher une requête corrélée sur n8n puis récupérer le résultat.

Étape 1 — génère un correlation_id :
  CID=$(uuidgen | tr -d '\n')    # ou n'importe quel string unique 1-128 chars

Étape 2 — déclenche le workflow n8n avec ce CID dans le payload :
  curl -X POST "$N8N_TRIGGER_URL" \
    -H "Content-Type: application/json" \
    -d "{\"correlation_id\":\"$CID\", \"demande\":\"...\"}"

  (le workflow n8n DOIT renvoyer son résultat à la queue avec ce même ID :
   POST $QUEUE_URL/webhook + header x-correlation-id: $CID)

Étape 3 — attends le résultat en faisant du polling ciblé :
  for i in {1..60}; do
    RESP=$(curl -sf -o /dev/null -w "%{http_code}" \
      "$QUEUE_URL/by-id/$CID" \
      -H "x-webhook-secret: $WEBHOOK_SECRET")
    if [ "$RESP" = "200" ]; then
      curl -s "$QUEUE_URL/by-id/$CID" \
        -H "x-webhook-secret: $WEBHOOK_SECRET" | jq
      break
    fi
    sleep 5
  done

Règle d'idempotence : une fois le message récupéré (200), un 2ᵉ appel
renvoie 410 Gone. Persiste donc le résultat au premier succès.

Si tu veux juste VÉRIFIER sans consommer (ex: pour retry), ajoute
?peek=true : GET /by-id/$CID?peek=true — la lecture n'est pas destructive
et le message reste disponible pour un claim ultérieur.
```

### Codes de retour à gérer

| Code | Signification | Que faire |
|------|---------------|-----------|
| `200` | Résultat disponible | Traiter le payload |
| `404` | Pas encore arrivé | Retry plus tard (polling) |
| `410` | Déjà consommé | Tu l'as déjà lu — réutiliser la donnée stockée |
| `400` | CID malformé | Bug côté producteur — vérifier la regex |
| `401` | Auth KO | Vérifier `$WEBHOOK_SECRET` |

### Comparaison `GET /next` vs `GET /by-id`

|                           | `/next`                                 | `/by-id/:cid`                          |
|---------------------------|-----------------------------------------|----------------------------------------|
| Quel message ?            | Le plus ancien (FIFO)                  | Celui dont le correlation_id matche    |
| Ordre d'arrivée important | Oui                                     | Non — on cible                         |
| Usage                     | Queue de tâches génériques              | Request-response corrélé               |
| Cas "vide"                | `empty: true`                           | `404 not_found`                        |
| Peek (non-destructif)     | Via `/peek` (tous)                      | Via `?peek=true` (ce message seul)     |

---

## 7. Template de system prompt permanent

À coller **une fois** dans le system prompt de Cowork pour qu'il sache
gérer la queue à tout moment.

```
Tu as accès à une webhook queue HTTP auto-hébergée qui reçoit des messages
depuis n8n (workflows automatisés).

Configuration :
- URL de base : https://queue.igk-digital.cloud
- Authentification : header HTTP `x-webhook-secret` dont la valeur est
  dans la variable d'environnement $WEBHOOK_SECRET
- Format : JSON en entrée comme en sortie

Endpoints utiles :
- GET /next                 → dépile le prochain message (FIFO). Réponse :
                              { ok, empty, item: { id, source, correlation_id,
                                created_at, payload }, pending }
                              Si empty=true, il n'y a rien à traiter.
- GET /by-id/:cid           → récupère UN message précis par son correlation_id
                              (que le producteur a fourni via x-correlation-id).
                              Atomique + destructif comme /next.
                              Ajoute ?peek=true pour lire sans consommer.
                              404 = n'existe pas encore (retry plus tard).
                              410 = déjà consommé.
- GET /peek                 → liste les 50 derniers messages SANS les dépiler.
- GET /status               → health check public, pas besoin d'auth.
- GET /stats                → stats auth (total, pending, read_count).

Règles :
1. /next et /by-id sont DESTRUCTIFS : un message récupéré ne peut plus être
   re-consommé (il bascule en "read" et sera supprimé après 48h).
2. Rate limit côté serveur : 100 requêtes/min/IP sur /webhook uniquement.
   Pour /next et /by-id, sois raisonnable (poll toutes les 5-30 secondes max).
3. Traite le champ `item.payload` — c'est le JSON exact envoyé par n8n.
4. Si tu reçois 401 : arrête tout et signale un problème d'auth.
5. Si tu reçois 429 : attends 60s avant de retenter.
6. Pour un pattern request-response : génère un UUID côté Cowork, envoie-le à
   n8n comme partie de la demande, n8n le réinjecte via x-correlation-id au
   retour, puis Cowork poll GET /by-id/<uuid> jusqu'à obtenir un 200.

Quand l'utilisateur dit :
- "vérifie la queue" / "récupère le dernier message" → /next
- "regarde ce qu'il y a" → /peek
- "récupère la réponse à ma requête <ID>" → /by-id/<ID>
```

---

## 8. Mémo : format du message reçu

Ce que Cowork obtiendra via `GET /next` :

```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "4f8a1234-...-uuid",
    "source": "n8n",
    "created_at": "2026-04-19T10:00:00.000Z",
    "read_at":    "2026-04-19T10:05:12.345Z",
    "delete_at":  "2026-04-21T10:05:12.345Z",
    "payload": {
      "...": "le JSON exact envoyé par n8n"
    }
  },
  "pending": 2
}
```

- `item.payload` → c'est là que se trouve la vraie information métier.
- `item.source` → permet de savoir quel producteur a envoyé le message
  (utile si plusieurs workflows n8n alimentent la même queue).
- `pending` → combien de messages restent à traiter après celui-ci.

Si la queue est vide :
```json
{ "ok": true, "empty": true, "item": null }
```

---

## Exemple concret — demander à Cowork de vérifier la queue

**Message utilisateur → Cowork :**

> Récupère le dernier rapport envoyé par n8n.

**Action attendue de Cowork :**

```bash
curl -sf "$QUEUE_URL/next" -H "x-webhook-secret: $WEBHOOK_SECRET"
```

**Réponse typique que Cowork doit gérer :**

```json
{
  "ok": true,
  "empty": false,
  "item": {
    "id": "…",
    "source": "n8n-workflow-42",
    "payload": {
      "event": "weekly_report",
      "week": "2026-W16",
      "summary_url": "https://...",
      "highlights": ["…", "…"]
    }
  }
}
```

Cowork extrait `item.payload` et traite selon le contenu (ici : `event: "weekly_report"` → restituer le résumé à l'utilisateur).
