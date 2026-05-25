FROM node:22-slim

WORKDIR /app

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

RUN pnpm install --frozen-lockfile

COPY . .

# VITE_ vars are embedded at build time — pass PUBLIC_IP as build arg
ARG VITE_MEDIAMTX_URL=http://localhost:8888
ARG VITE_APP_ID=blueeye
ENV VITE_MEDIAMTX_URL=$VITE_MEDIAMTX_URL
ENV VITE_APP_ID=$VITE_APP_ID

RUN pnpm run build

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
