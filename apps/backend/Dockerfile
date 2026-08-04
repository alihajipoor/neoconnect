# Build context is the monorepo root (see infra/docker-compose.prod.yml),
# because pnpm workspace install needs every workspace package.json present.
FROM node:20-alpine AS base
# Without openssl, Prisma can't detect this image's libssl version at
# `prisma generate` time and silently guesses wrong (openssl-1.1.x on an
# image that actually ships OpenSSL 3.x), which then makes the runtime
# client try to self-heal by downloading the correct engine on first
# request — and fails, since the non-root runtime user can't write into
# node_modules. Installing openssl up front means generate picks the
# right engine and no runtime fetch is ever attempted.
RUN apk add --no-cache openssl
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
RUN pnpm --filter @neoxify/backend prisma:generate
RUN pnpm --filter @neoxify/backend build
# Compiled separately from the main build (which deliberately excludes
# prisma/ so its rootDir inference doesn't shift dist/main.js — see
# tsconfig.build.json). ts-node itself is a devDependency and doesn't
# ship in the runtime image, so seeding in production needs plain JS.
RUN pnpm --filter @neoxify/backend build:seed
# --prod deploy dereferences the workspace's pnpm-store symlinks into a
# self-contained directory with only production dependencies, so the
# runtime image doesn't need pnpm or the workspace layout at all.
RUN pnpm --filter @neoxify/backend --prod deploy /out
# `deploy` re-resolves node_modules from scratch in /out, which wipes out
# the Prisma Client generated above (its own postinstall ran with no
# schema present yet, so it generated nothing). Regenerate against the
# deployed node_modules now that the schema is there too, so the client
# that actually ships in the runtime image is a real one.
RUN cp -r apps/backend/prisma /out/prisma
RUN cd /out && node_modules/.bin/prisma generate

# --- Runtime image -----------------------------------------------------
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nestjs && adduser -S nestjs -G nestjs

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/prisma ./prisma
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/backend/dist-seed ./dist-seed
COPY --from=build /repo/packages/proto ./proto

USER nestjs
EXPOSE 4000 50051
ENV PORT=4000

# Runs pending migrations before every boot. Safe to run on every
# container start/restart: migrate deploy is a no-op when the schema is
# already up to date, and this is what makes `docker compose up` alone
# enough to apply new migrations on an update, no separate step needed.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
