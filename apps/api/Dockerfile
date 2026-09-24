# Plano de control (API + CLI + migraciones). Contexto de build: raíz del repo.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agent-spec/package.json packages/agent-spec/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY examples/crm-mock/package.json examples/crm-mock/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @agentes/agent-spec build && pnpm --filter @agentes/api build && pnpm --filter @agentes/cli build \
 && pnpm deploy --filter @agentes/api --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TEMPLATES_DIR=/app/templates MIGRATIONS_DIR=/app/db/migrations
COPY --from=build /out apps/api
COPY templates templates
COPY db db
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
