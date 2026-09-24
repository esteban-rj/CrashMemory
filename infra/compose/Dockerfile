FROM node:24.14.1-bookworm-slim

WORKDIR /app

RUN npm install --global pnpm@11.25.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
ENV API_INTERNAL_URL=http://api:4310
RUN pnpm build

ENV NODE_ENV=production
