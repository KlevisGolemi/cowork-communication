FROM node:20-alpine

# Dépendances système pour better-sqlite3 (compilation native)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copier d'abord package.json pour profiter du cache Docker
COPY package*.json ./
RUN npm ci --only=production

# Copier le code
COPY server.js .

# Répertoire pour la base SQLite (monté en volume)
RUN mkdir -p /data

# Port exposé (interne container — Traefik route depuis l'extérieur)
EXPOSE 3333

# Healthcheck natif Docker
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3333/status || exit 1

# Utilisateur non-root pour la sécurité
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /data
USER appuser

CMD ["node", "server.js"]
