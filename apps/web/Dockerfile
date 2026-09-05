FROM node:24.19.0-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
RUN pnpm --filter @openbot/web build

FROM node:24.19.0-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/build ./

USER node

EXPOSE 3000

CMD ["node", "index.js"]
