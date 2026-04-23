#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  poll.sh — Script Cowork pour consommer la queue
#
#  Variables d'env attendues (ou passées en args) :
#    QUEUE_URL          ex: https://queue.igk-digital.cloud
#    WEBHOOK_SECRET     ta clé secrète
#
#  Usage :
#    ./poll.sh next              → dépile 1 message (le supprime)
#    ./poll.sh peek              → voir la queue sans toucher
#    ./poll.sh status            → état du serveur
#    ./poll.sh wait [secs]       → attendre jusqu'à un message (loop)
#    ./poll.sh all               → vider toute la queue d'un coup
#    ./poll.sh byid <cid>        → récupérer un message précis par correlation ID
#    ./poll.sh byid <cid> peek   → lire sans consommer
# ═══════════════════════════════════════════════════════════════

BASE_URL="${QUEUE_URL:-https://queue.igk-digital.cloud}"
SECRET="${WEBHOOK_SECRET:-}"
MODE="${1:-next}"
INTERVAL="${2:-5}"

# Headers communs
HEADERS=(-H "Content-Type: application/json")
[ -n "$SECRET" ] && HEADERS+=(-H "x-webhook-secret: $SECRET")

req() {
  curl -sf "${HEADERS[@]}" "$@"
}

case "$MODE" in

  next)
    RESULT=$(req "${BASE_URL}/next")
    if [ $? -ne 0 ]; then echo "ERREUR: serveur inaccessible" && exit 1; fi

    EMPTY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('empty','true'))" 2>/dev/null)
    if [ "$EMPTY" = "True" ] || [ "$EMPTY" = "true" ]; then
      echo "Queue vide — rien à traiter"
      exit 0
    fi

    echo "=== MESSAGE REÇU ==="
    echo "$RESULT" | python3 -m json.tool
    echo "=== FIN ==="
    ;;

  peek)
    req "${BASE_URL}/peek" | python3 -m json.tool
    ;;

  status)
    req "${BASE_URL}/status" | python3 -m json.tool
    ;;

  wait)
    echo "Attente d'un message (poll toutes les ${INTERVAL}s)..."
    while true; do
      RESULT=$(req "${BASE_URL}/next" 2>/dev/null)
      if [ $? -ne 0 ]; then
        echo "$(date '+%H:%M:%S') — serveur inaccessible, retry dans ${INTERVAL}s..."
        sleep "$INTERVAL"
        continue
      fi

      EMPTY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('empty','true'))" 2>/dev/null)
      if [ "$EMPTY" = "False" ] || [ "$EMPTY" = "false" ]; then
        echo "=== MESSAGE REÇU À $(date) ==="
        echo "$RESULT" | python3 -m json.tool
        echo "=== FIN ==="
        break
      fi

      echo "$(date '+%H:%M:%S') — queue vide, retry dans ${INTERVAL}s..."
      sleep "$INTERVAL"
    done
    ;;

  all)
    echo "Vidage complet de la queue..."
    COUNT=0
    while true; do
      RESULT=$(req "${BASE_URL}/next" 2>/dev/null)
      EMPTY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('empty','true'))" 2>/dev/null)
      [ "$EMPTY" = "True" ] || [ "$EMPTY" = "true" ] && break
      COUNT=$((COUNT + 1))
      echo "--- Message $COUNT ---"
      echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('item',{}), indent=2))"
    done
    echo "=== $COUNT message(s) récupéré(s) et supprimés ==="
    ;;

  byid)
    CID="$2"
    MODE_BYID="$3"
    if [ -z "$CID" ]; then
      echo "Usage: $0 byid <correlation_id> [peek]"
      exit 1
    fi
    URL="${BASE_URL}/by-id/${CID}"
    [ "$MODE_BYID" = "peek" ] && URL="${URL}?peek=true"
    HTTP_CODE=$(curl -s -o /tmp/byid_resp.json -w "%{http_code}" "${HEADERS[@]}" "$URL")
    case "$HTTP_CODE" in
      200) echo "=== MESSAGE ($CID) ==="; cat /tmp/byid_resp.json | python3 -m json.tool ;;
      404) echo "404 — pas encore arrivé pour '$CID'" ;;
      410) echo "410 — déjà consommé :"; cat /tmp/byid_resp.json | python3 -m json.tool ;;
      400) echo "400 — correlation_id malformé" ;;
      401) echo "401 — auth KO, vérifie WEBHOOK_SECRET" ;;
      *)   echo "HTTP $HTTP_CODE :"; cat /tmp/byid_resp.json ;;
    esac
    rm -f /tmp/byid_resp.json
    ;;

  *)
    echo "Usage: $0 [next|peek|status|wait|all|byid] [...]"
    exit 1
    ;;
esac
