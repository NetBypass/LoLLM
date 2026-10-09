# LoLLM — Local LLM Gateway.
# Nol dependensi runtime: tidak ada `npm install` di dalam image. Dashboard sudah di-build
# dan di-commit di public/, jadi image hanya menyalin sumber + hasil build.
#
# Build lokal:  docker build -t lollm:dev .
# Jalankan:     docker run -d -p 5151:5151 -v lollm-data:/app/data --name lollm lollm:dev
# Gateway key:  docker exec lollm node bin/lollm.js key

FROM node:22-alpine

LABEL org.opencontainers.image.title="LoLLM" \
      org.opencontainers.image.description="Local LLM Gateway — multi-provider fallback, routing kualitas, dashboard. Zero dependency." \
      org.opencontainers.image.source="https://github.com/NetBypass/LoLLM" \
      org.opencontainers.image.documentation="https://github.com/NetBypass/LoLLM/blob/main/README.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:22-alpine"

# Diisi oleh CI (docker/metadata-action) atau `--build-arg`; label ini yang membuat
# `docker inspect` / halaman paket GHCR menampilkan versi yang benar.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app

COPY --chown=node:node package.json LICENSE README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# Data (config.json + gateway key + statistik) di luar image supaya upgrade tidak
# menghapus pengaturan. Mount volume/copy dir ini untuk persistensi.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# Jalan sebagai non-root; HANYA port yang ditulis di ENV yang perlu dibuka.
USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5151 \
    LOLLM_HOME=/app/data

EXPOSE 5151

# Liveness murah: /healthz tidak pernah menyentuh upstream, jadi container bertanda
# "sehat" walau belum ada provider. Readiness (provider siap) dicek orchestrator lewat
# /readyz — sengaja bukan di sini supaya image fresh tidak dianggap gagal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5151}/healthz" > /dev/null || exit 1

# node menangkap SIGTERM → shutdown bersih (bin/lollm.js), tanpa koneksi menggantung.
STOPSIGNAL SIGTERM
CMD ["node", "bin/lollm.js"]
