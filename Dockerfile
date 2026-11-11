FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
RUN node scripts/build.mjs

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 ASSET_DIRECTORY=dist ROOM_DATA_FILE=/app/data/rooms.json
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server ./server
RUN mkdir data && chown node:node data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
