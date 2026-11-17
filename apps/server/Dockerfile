FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /opt/digitalbots/apps/server
COPY apps/server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY apps/server/src ./src
COPY apps/server/public ./public
EXPOSE 6767
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
