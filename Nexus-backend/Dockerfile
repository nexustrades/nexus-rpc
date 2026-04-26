FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
