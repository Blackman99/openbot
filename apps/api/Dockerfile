FROM node:24.19.0-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
RUN pnpm --filter @openbot/api build
RUN pnpm --filter @openbot/api deploy --prod --legacy /runtime

FROM node:24.19.0-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /runtime/package.json ./package.json
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist

USER node

EXPOSE 3001

CMD ["node", "dist/server.js"]
