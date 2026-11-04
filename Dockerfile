FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.19.0-bookworm-slim

ARG STRATA_COMMIT=dev
ENV STRATA_COMMIT=$STRATA_COMMIT \
    NODE_ENV=production \
    STRATA_HOST=0.0.0.0 \
    STRATA_PORT=8080 \
    STRATA_DATA=/data
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tools/backup.mjs tools/check-db.mjs tools/prune-backups.mjs ./tools/
COPY ops/update.sh ./ops/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=180s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/gateway/main.ts"]
