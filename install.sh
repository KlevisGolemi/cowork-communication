#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  install.sh — Configuration interactive de la Webhook Queue
#
#  Génère un .env, vérifie les prérequis, crée le réseau Traefik
#  si besoin, et (optionnellement) lance `docker compose up -d`.
#
#  Usage :
#    ./install.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Sortie colorée ───────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info() { echo "${BLUE}▶${NC} $*"; }
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}⚠${NC} $*"; }
fail() { echo "${RED}✗${NC} $*" >&2; exit 1; }

# Se placer dans le répertoire du script
cd "$(dirname "$0")"

# ─── Prérequis ────────────────────────────────────────────────
command -v docker  >/dev/null 2>&1 || fail "Docker requis (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 requis (docker compose)"
command -v openssl >/dev/null 2>&1 || fail "openssl requis pour générer le secret"

# ─── Garde-fou sur un .env existant ───────────────────────────
if [ -f .env ]; then
  warn "Un fichier .env existe déjà."
  read -rp "    Écraser la configuration ? [y/N] " yn
  case "$yn" in
    [yY]*) ;;
    *) info "Installation annulée — .env conservé."; exit 0 ;;
  esac
fi

# ─── Helper prompt avec valeur par défaut ─────────────────────
ask() {
  local label="$1" default="${2:-}" __var="$3" reply=""
  if [ -n "$default" ]; then
    read -rp "    $label [$default]: " reply
    reply="${reply:-$default}"
  else
    while [ -z "$reply" ]; do
      read -rp "    $label: " reply
    done
  fi
  printf -v "$__var" '%s' "$reply"
}

# ─── Collecte config ──────────────────────────────────────────
echo
info "Configuration de la Webhook Queue"
echo

info "Domaine public"
ask "Sous-domaine" "queue" SUBDOMAIN
ask "Domaine racine (ex: exemple.com)" "" ROOT_DOMAIN
DOMAIN="$SUBDOMAIN.$ROOT_DOMAIN"
echo "    → URL complète : https://$DOMAIN"
echo

info "Domaine MCP (serveur Model Context Protocol pour Claude)"
echo "    → Crée un DNS A record pour ce sous-domaine vers l'IP de ton VPS."
echo "    → Suggestion : mcp.$ROOT_DOMAIN"
ask "Sous-domaine MCP" "mcp" MCP_SUBDOMAIN
MCP_DOMAIN="$MCP_SUBDOMAIN.$ROOT_DOMAIN"
echo "    → URL MCP complète : https://$MCP_DOMAIN"
echo

info "Token MCP"
MCP_TOKEN="$(openssl rand -hex 16)"
ok "MCP_TOKEN généré (32 caractères hex)"
echo

info "Secret d'authentification"
read -rp "    Générer automatiquement un secret fort ? [Y/n] " yn
if [[ "${yn:-Y}" =~ ^[nN] ]]; then
  SECRET=""
  while [ ${#SECRET} -lt 32 ]; do
    read -rp "    WEBHOOK_SECRET (32+ caractères) : " SECRET
    [ ${#SECRET} -lt 32 ] && warn "trop court (${#SECRET} caractères)"
  done
else
  SECRET="$(openssl rand -hex 32)"
  ok "Secret généré (64 caractères hex)"
fi
echo

info "Réglages avancés (laisser vide pour accepter)"
ask "Port interne du container" "3333" PORT
ask "Rétention messages (heures)" "48" TTL
ask "Fréquence cleanup (minutes)" "60" CLEAN
echo

# ─── Écriture du .env ─────────────────────────────────────────
cat > .env <<EOF
# Généré par install.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)

DOMAIN=$DOMAIN
WEBHOOK_SECRET=$SECRET
PORT=$PORT
DB_PATH=/data/queue.db
TTL_HOURS=$TTL
CLEANUP_INTERVAL_MIN=$CLEAN

# ── MCP Server distant ───────────────────────────────────
MCP_DOMAIN=$MCP_DOMAIN
MCP_TOKEN=$MCP_TOKEN
EOF
chmod 600 .env
ok ".env créé (chmod 600)"

# ─── Réseau Traefik ───────────────────────────────────────────
if ! docker network inspect traefik_proxy >/dev/null 2>&1; then
  warn "Le réseau Docker 'traefik_proxy' n'existe pas."
  read -rp "    Le créer ? [y/N] " yn
  if [[ "${yn:-N}" =~ ^[yY] ]]; then
    docker network create traefik_proxy >/dev/null
    ok "Réseau 'traefik_proxy' créé"
    warn "Rappel : Traefik doit tourner sur ce réseau avec un certresolver 'letsencrypt'."
  else
    warn "Sans ce réseau, 'docker compose up' échouera — à créer avant le lancement."
  fi
else
  ok "Réseau 'traefik_proxy' détecté"
fi
echo

# ─── Build & start ────────────────────────────────────────────
read -rp "$(info "Lancer 'docker compose up -d --build' maintenant ? [Y/n]") " yn
if [[ ! "${yn:-Y}" =~ ^[nN] ]]; then
  docker compose up -d --build
  echo
  ok "Service lancé."
  info "Test rapide (depuis le serveur) :"
  echo "    curl -s https://$DOMAIN/status"
else
  info "Pour lancer plus tard : docker compose up -d --build"
fi

# ─── Récap ────────────────────────────────────────────────────
echo
info "═══ Récapitulatif ═══════════════════════════════════════"
echo "    URL publique  : https://$DOMAIN"
echo "    Secret        : $SECRET"
echo "    Fichier .env  : $(pwd)/.env"
echo
info "Pour le consommateur (Cowork), exporte :"
echo "    export QUEUE_URL=https://$DOMAIN"
echo "    export WEBHOOK_SECRET=$SECRET"
echo
warn "Pré-requis côté infrastructure :"
echo "    • DNS : $DOMAIN → IP de ce serveur"
echo "    • DNS : $MCP_DOMAIN → IP de ce serveur"
echo "    • Traefik actif avec entrypoint 'websecure' et certresolver 'letsencrypt'"
echo "    • Port 443 ouvert sur le firewall"
echo

ok "Installation terminée."
echo
echo "    Queue webhook : https://$DOMAIN"
echo "    MCP endpoint  : https://$MCP_DOMAIN/t/$MCP_TOKEN/mcp"
echo
info "Pour connecter Claude → Paramètres → Connecteurs personnalisés :"
echo "    Nom : Cowork Queue"
echo "    URL : https://$MCP_DOMAIN/t/$MCP_TOKEN/mcp"
echo
warn "N'oublie pas de créer un DNS A record pour $MCP_DOMAIN vers ton IP VPS."
echo
