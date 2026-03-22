# Engram — Semantic Memory System
# Single-stage Node.js build with non-root user.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -g 1001 engram \
    && useradd -u 1001 -g engram -m -s /bin/sh engram

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application
COPY --chown=1001:1001 index.js ./

USER engram

ENV PORT=3700

EXPOSE 3700

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:3700/health || exit 1

CMD ["node", "index.js"]
