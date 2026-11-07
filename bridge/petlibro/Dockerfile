# petlibro-bridge — built and pushed by .github/workflows/petlibro-bridge.yml
# (linux/amd64 + linux/arm64, so it runs on any Synology that runs Docker).
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTPASSWD_FILE=/auth/htpasswd \
    MQTT_PORT=1883 \
    HTTP_PORT=8484 \
    TZ=Europe/Paris

# tzdata so TZ also applies to the timestamps docker logs shows; the bridge's
# own timezone maths uses Node's ICU, not this.
RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 1883 8484

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HTTP_PORT}/health" || exit 1

CMD ["node", "src/index.js"]
