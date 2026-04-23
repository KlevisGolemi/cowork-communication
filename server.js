const express = require('express')
const rateLimit = require('express-rate-limit')
const Database = require('better-sqlite3')
const crypto = require('crypto')

const app = express()

// Traefik se trouve en frontal — on fait confiance à 1 proxy pour que req.ip
// renvoie le vrai client (utile pour le rate limiting).
app.set('trust proxy', 1)

app.use(express.json({ limit: '1mb' }))

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3333')
const SECRET      = process.env.WEBHOOK_SECRET || ''
const TTL_HOURS   = parseInt(process.env.TTL_HOURS || '48')
const CLEANUP_MIN = parseInt(process.env.CLEANUP_INTERVAL_MIN || '60')
const DB_PATH     = process.env.DB_PATH || '/data/queue.db'
const NODE_ENV    = process.env.NODE_ENV || 'production'

function log(level, msg) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg }))
}

// Fail-fast : en production, refuser de démarrer sans secret d'auth.
if (!SECRET && NODE_ENV === 'production') {
  log('error', 'WEBHOOK_SECRET manquant en production — arrêt.')
  process.exit(1)
}

// ─── BASE DE DONNÉES ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL DEFAULT 'n8n',
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    read_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_status     ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_read_at    ON messages(read_at);
`)

// ─── MIGRATION idempotente : colonne correlation_id + index unique partiel ────
// Safe sur DB existante : les anciennes lignes restent correlation_id=NULL.
// L'index partiel `WHERE correlation_id IS NOT NULL` autorise N lignes NULL
// mais garantit l'unicité sur toute valeur fournie (SQLite ≥ 3.25).
const existingCols = db.prepare(`PRAGMA table_info(messages)`).all()
if (!existingCols.some(c => c.name === 'correlation_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN correlation_id TEXT`)
  log('info', 'Migration: colonne correlation_id ajoutee')
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_correlation_id_unique
         ON messages(correlation_id) WHERE correlation_id IS NOT NULL`)

// Validation commune du correlation_id (header POST + param GET)
const CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

// Statements prepares
const stmtInsert       = db.prepare(`INSERT INTO messages (id, source, payload, status, created_at, correlation_id) VALUES (?, ?, ?, 'pending', ?, ?)`)

// UPDATE … RETURNING : atomique, élimine la race condition entre deux consommateurs
// (requiert SQLite ≥ 3.35, garanti par better-sqlite3).
const stmtClaimNext    = db.prepare(`
  UPDATE messages
     SET status = 'read', read_at = ?
   WHERE id = (
     SELECT id FROM messages
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
   )
  RETURNING id, source, payload, created_at, read_at, correlation_id
`)

// Recherche par correlation_id (non-destructive)
const stmtFindByCorrelation  = db.prepare(`SELECT id, source, payload, status, created_at, read_at, correlation_id FROM messages WHERE correlation_id = ?`)

// Claim atomique par correlation_id : bascule 'pending' -> 'read' uniquement
const stmtClaimByCorrelation = db.prepare(`
  UPDATE messages
     SET status = 'read', read_at = ?
   WHERE correlation_id = ? AND status = 'pending'
  RETURNING id, source, payload, created_at, read_at, correlation_id
`)

const stmtCleanRead    = db.prepare(`DELETE FROM messages WHERE status = 'read' AND read_at < ?`)
const stmtCleanExpired = db.prepare(`DELETE FROM messages WHERE status = 'pending' AND created_at < ?`)
const stmtPeek         = db.prepare(`SELECT id, source, status, created_at, read_at, correlation_id, payload FROM messages ORDER BY created_at DESC LIMIT 50`)
const stmtCount        = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status='read'    THEN 1 ELSE 0 END) as read_count
  FROM messages
`)
const stmtDeleteAll    = db.prepare(`DELETE FROM messages`)

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch (err) {
    log('warn', `payload JSON corrompu — renvoi brut`)
    return { __corrupted: true, raw }
  }
}

// ─── CLEANUP TTL ──────────────────────────────────────────────────────────────
function runCleanup() {
  const cutoff = Date.now() - (TTL_HOURS * 60 * 60 * 1000)

  // Messages lus depuis plus de TTL_HOURS → supprimés
  const r1 = stmtCleanRead.run(cutoff)

  // Messages jamais lus mais plus vieux que TTL_HOURS → supprimés (sécurité)
  const r2 = stmtCleanExpired.run(cutoff)

  const total = r1.changes + r2.changes
  if (total > 0) {
    log('info', `TTL cleanup: ${r1.changes} lu(s) + ${r2.changes} expiré(s) non lu(s) supprimés`)
  }
}

runCleanup()
setInterval(runCleanup, CLEANUP_MIN * 60 * 1000)
log('info', `Cleanup: toutes les ${CLEANUP_MIN}min — TTL ${TTL_HOURS}h`)

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  // En dev sans secret, on laisse passer ; en prod le fail-fast au boot
  // garantit que SECRET est toujours défini ici.
  if (!SECRET) return next()
  const provided = req.headers['x-webhook-secret']
  // Comparaison à temps constant pour éviter les attaques par timing.
  const providedBuf = Buffer.from(String(provided || ''))
  const secretBuf   = Buffer.from(SECRET)
  const ok = providedBuf.length === secretBuf.length &&
             crypto.timingSafeEqual(providedBuf, secretBuf)
  if (!ok) {
    log('warn', `Auth failed from ${req.ip} — ${req.path}`)
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }
  next()
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// Protection contre la saturation du disque SQLite si le secret est fuité.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
})

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// POST /webhook  ← n8n envoie ici
app.post('/webhook', webhookLimiter, auth, (req, res) => {
  const id = crypto.randomUUID()
  const source = req.headers['x-source'] || 'n8n'
  const payload = JSON.stringify(req.body)
  const now = Date.now()

  // Correlation ID optionnel — permet la récupération ciblée via GET /by-id/:cid
  const rawCid = (req.headers['x-correlation-id'] || '').toString().trim()
  const correlationId = rawCid.length > 0 ? rawCid : null
  if (correlationId !== null && !CORRELATION_ID_REGEX.test(correlationId)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_correlation_id',
      hint: 'Format attendu : ^[A-Za-z0-9_-]{1,128}$'
    })
  }

  try {
    stmtInsert.run(id, source, payload, now, correlationId)
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = stmtFindByCorrelation.get(correlationId)
      log('warn', `DUPLICATE correlation_id=${correlationId} — existant: ${existing ? existing.id : '?'}`)
      return res.status(409).json({
        ok: false,
        error: 'duplicate_correlation_id',
        correlation_id: correlationId,
        existing_id: existing ? existing.id : null
      })
    }
    throw err
  }

  const stats = stmtCount.get()
  log('info', `ENQUEUED [${id}] source=${source} cid=${correlationId || '-'} — pending: ${stats.pending}`)
  res.json({ ok: true, id, correlation_id: correlationId, pending: stats.pending })
})

// GET /next  ← Cowork dépile et marque comme lu (gardé 48h puis supprimé)
app.get('/next', auth, (req, res) => {
  const now = Date.now()
  const msg = stmtClaimNext.get(now) // SELECT + UPDATE atomique

  if (!msg) {
    return res.json({ ok: true, empty: true, item: null })
  }

  const stats = stmtCount.get()
  const deleteAt = new Date(now + TTL_HOURS * 60 * 60 * 1000).toISOString()

  log('info', `READ [${msg.id}] — sera supprimé le ${deleteAt} — pending restant: ${stats.pending}`)

  res.json({
    ok: true,
    empty: false,
    item: {
      id: msg.id,
      source: msg.source,
      correlation_id: msg.correlation_id,
      created_at: new Date(msg.created_at).toISOString(),
      read_at: new Date(msg.read_at).toISOString(),
      delete_at: deleteAt,
      payload: safeParse(msg.payload)
    },
    pending: stats.pending
  })
})

// GET /by-id/:correlation_id  ← récupérer un message précis par son correlation ID
//   défaut = claim destructif (marque 'read', supprimé après TTL)
//   ?peek=true = lecture non-destructive, renvoie quel que soit le statut
app.get('/by-id/:correlation_id', auth, (req, res) => {
  const cid = (req.params.correlation_id || '').trim()
  if (!CORRELATION_ID_REGEX.test(cid)) {
    return res.status(400).json({ ok: false, error: 'invalid_correlation_id' })
  }
  const peek = req.query.peek === 'true' || req.query.peek === '1'
  const now = Date.now()

  if (peek) {
    const msg = stmtFindByCorrelation.get(cid)
    if (!msg) {
      return res.status(404).json({ ok: false, error: 'not_found', correlation_id: cid })
    }
    return res.json({
      ok: true,
      peek: true,
      item: {
        id: msg.id,
        source: msg.source,
        correlation_id: msg.correlation_id,
        status: msg.status,
        created_at: new Date(msg.created_at).toISOString(),
        read_at: msg.read_at ? new Date(msg.read_at).toISOString() : null,
        payload: safeParse(msg.payload)
      }
    })
  }

  // Claim destructif atomique
  const msg = stmtClaimByCorrelation.get(now, cid)
  if (!msg) {
    // Disambiguïsation : inexistant vs déjà lu
    const existing = stmtFindByCorrelation.get(cid)
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'not_found', correlation_id: cid })
    }
    return res.status(410).json({
      ok: false,
      error: 'already_read',
      correlation_id: cid,
      id: existing.id,
      read_at: existing.read_at ? new Date(existing.read_at).toISOString() : null
    })
  }

  const stats = stmtCount.get()
  const deleteAt = new Date(now + TTL_HOURS * 60 * 60 * 1000).toISOString()
  log('info', `READ by cid=${cid} [${msg.id}] — sera supprimé le ${deleteAt} — pending: ${stats.pending}`)

  res.json({
    ok: true,
    empty: false,
    item: {
      id: msg.id,
      source: msg.source,
      correlation_id: msg.correlation_id,
      created_at: new Date(msg.created_at).toISOString(),
      read_at: new Date(msg.read_at).toISOString(),
      delete_at: deleteAt,
      payload: safeParse(msg.payload)
    },
    pending: stats.pending
  })
})

// GET /peek  ← voir la queue sans toucher
app.get('/peek', auth, (req, res) => {
  const rows = stmtPeek.all()
  const stats = stmtCount.get()
  res.json({
    ok: true,
    stats,
    items: rows.map(r => ({
      id: r.id,
      source: r.source,
      correlation_id: r.correlation_id,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      read_at: r.read_at ? new Date(r.read_at).toISOString() : null,
      payload: safeParse(r.payload)
    }))
  })
})

// GET /status  ← health check public (pas d'auth — pour Traefik)
// Minimal : ne divulgue pas la charge de la queue à l'extérieur.
app.get('/status', (req, res) => {
  res.json({ ok: true, uptime_s: Math.floor(process.uptime()) })
})

// GET /stats  ← détails derrière l'auth
app.get('/stats', auth, (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.floor(process.uptime()),
    ttl_hours: TTL_HOURS,
    cleanup_interval_min: CLEANUP_MIN,
    stats: stmtCount.get()
  })
})

// DELETE /clear  ← vider toute la queue (debug uniquement)
app.delete('/clear', auth, (req, res) => {
  stmtDeleteAll.run()
  log('warn', 'Queue cleared by request')
  res.json({ ok: true })
})

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log('info', 'SIGTERM — fermeture propre')
  db.close()
  process.exit(0)
})

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log('info', `Webhook Queue démarré sur :${PORT}`)
  log('info', `AUTH: ${SECRET ? 'enabled' : 'DISABLED — ajouter WEBHOOK_SECRET dans .env !'}`)
})
