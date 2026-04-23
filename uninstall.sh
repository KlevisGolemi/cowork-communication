#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  uninstall.sh — Désinstallation complète de la Webhook Queue
#
#  Arrête le container, supprime le volume (= les données SQLite),
#  retire l'image Docker et le .env local.
#
#  Usage :
#    ./uninstall.sh              (interactif — confirme chaque étape)
#    ./uninstall.sh --yes        (non-interactif — tout supprime)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info() { echo "${BLUE}▶${NC} $*"; }
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}⚠${NC} $*"; }
fail() { echo "${RED}✗${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")"

AUTO_YES=false
[ "${1:-}" = "--yes" ] && AUTO_YES=true

confirm() {
  local prompt="$1"
  $AUTO_YES && return 0
  read -rp "    $prompt [y/N] " yn
  [[ "${yn:-N}" =~ ^[yY] ]]
}

command -v docker >/dev/null 2>&1 || fail "Docker requis"

echo
info "Désinstallation de la Webhook Queue"
warn "Cette opération est destructive — la base SQLite et tous les messages seront perdus."
echo

# ─── 1. Stop + remove container + volumes ─────────────────────
if docker compose ps -q 2>/dev/null | grep -q .; then
  if confirm "Arrêter le container et supprimer le volume 'queue_data' (données SQLite) ?"; then
    docker compose down -v
    ok "Container + volume supprimés"
  else
    info "Container conservé — arrêt de la désinstallation."
    exit 0
  fi
else
  info "Aucun container actif détecté via docker compose."
  # Tentative de nettoyage direct par nom, au cas où
  if docker ps -a --format '{{.Names}}' | grep -q '^webhook-queue$'; then
    if confirm "Container 'webhook-queue' trouvé hors compose — le supprimer ?"; then
      docker rm -f webhook-queue
      ok "Container supprimé"
    fi
  fi
  if docker volume ls -q | grep -q 'queue_data$'; then
    if confirm "Volume 'queue_data' encore présent — le supprimer ?"; then
      docker volume rm "$(docker volume ls -q | grep 'queue_data$')" >/dev/null
      ok "Volume supprimé"
    fi
  fi
fi

# ─── 2. Image Docker ──────────────────────────────────────────
IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)(cowork_communication|webhook-queue)[-_]?(webhook-queue)?' | head -1 || true)"
if [ -n "$IMAGE" ]; then
  if confirm "Supprimer l'image Docker '$IMAGE' ?"; then
    docker rmi "$IMAGE" >/dev/null
    ok "Image supprimée"
  fi
fi

# ─── 3. Fichier .env ──────────────────────────────────────────
if [ -f .env ]; then
  if confirm "Supprimer le fichier .env (contient le WEBHOOK_SECRET) ?"; then
    rm -f .env
    ok ".env supprimé"
  else
    warn ".env conservé — pense à le retirer manuellement si tu ne redéploies pas."
  fi
fi

# ─── 4. Réseau traefik_proxy (prudence : partagé) ─────────────
if docker network inspect traefik_proxy >/dev/null 2>&1; then
  IN_USE="$(docker network inspect traefik_proxy --format '{{len .Containers}}')"
  if [ "$IN_USE" -eq 0 ]; then
    if confirm "Le réseau 'traefik_proxy' n'est plus utilisé — le supprimer ?"; then
      docker network rm traefik_proxy >/dev/null
      ok "Réseau supprimé"
    fi
  else
    info "Réseau 'traefik_proxy' encore utilisé par $IN_USE container(s) — conservé."
  fi
fi

echo
ok "Désinstallation terminée."
info "Pour réinstaller plus tard : ./install.sh"
echo
