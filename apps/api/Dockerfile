# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @riven/api

COPY apps/api apps/api
RUN pnpm --filter @riven/api exec prisma generate \
  && pnpm --filter @riven/api build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /repo
# pnpm keeps the generated Prisma client inside node_modules/.pnpm, so the
# installed tree is copied whole rather than re-installed with --prod.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json

WORKDIR /repo/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
