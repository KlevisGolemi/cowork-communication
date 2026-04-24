# ═══════════════════════════════════════════════════════════════
#  cowork-mcp — serveur MCP distant (Streamable HTTP)
# ═══════════════════════════════════════════════════════════════

# ─── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ─── Runtime stage ───────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Fichiers statiques de l'interface admin
COPY public ./public

# Utilisateur non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080
CMD ["node", "dist/index.js"]
