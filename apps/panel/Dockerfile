# Build context is the monorepo root (see infra/docker-compose.prod.yml),
# because pnpm workspace install needs every workspace package.json present.
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/panel/package.json apps/panel/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @neoxify/panel build

# --- Runtime image -----------------------------------------------------
# Next.js standalone output, traced from the workspace root, nests the
# server entrypoint at apps/panel/server.js inside the standalone folder.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build /repo/apps/panel/.next/standalone ./
COPY --from=build /repo/apps/panel/.next/static ./apps/panel/.next/static
COPY --from=build /repo/apps/panel/public ./apps/panel/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/panel/server.js"]
