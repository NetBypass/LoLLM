FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/NetBypass/LoLLM" \
      org.opencontainers.image.description="LoLLM — Local LLM Gateway" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --chown=node:node package.json LICENSE README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

RUN mkdir -p /app/data && chown node:node /app/data

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5151 \
    LOLLM_HOME=/app/data

VOLUME ["/app/data"]
EXPOSE 5151

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5151/healthz || exit 1

CMD ["node", "bin/lollm.js"]
