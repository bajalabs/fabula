# Fabula: the service and every engine in one image.
#
#   Typst 0.15.1, Pandoc 3.13, Quarto 1.11.9, WeasyPrint 70.0, MJML 5 (a Node dependency), Chromium (Debian's),
#   Poppler for page previews, and the Noto fonts (core, mono, colour emoji). No LaTeX: Pandoc and Quarto write PDFs
#   through Typst. No R or Jupyter: Quarto never runs code cells.
#
# Every release archive is checked against its sha256, for both architectures; a new version needs its new sums.
# The image runs as the unprivileged `node` user, with /app read-only to it; the asset cache and the render folders
# live under /tmp. The Typst packages cetz and fletcher are cached at build time, so a render never downloads one.

# ── Typst, from its GitHub release ───────────────────────────────────
FROM alpine:3.20 AS typst-bin
ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256_X86_64=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
ARG TYPST_SHA256_AARCH64=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee
RUN apk add --no-cache curl tar xz \
 && ARCH=$(uname -m) \
 && case "$ARCH" in \
      x86_64)  TYPST_TARGET="x86_64-unknown-linux-musl";  TYPST_SHA256="$TYPST_SHA256_X86_64"  ;; \
      aarch64) TYPST_TARGET="aarch64-unknown-linux-musl"; TYPST_SHA256="$TYPST_SHA256_AARCH64" ;; \
      *) echo "Unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/typst.tar.xz \
      "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_TARGET}.tar.xz" \
 && echo "$TYPST_SHA256  /tmp/typst.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/typst.tar.xz -C /tmp \
 && mv "/tmp/typst-${TYPST_TARGET}/typst" /usr/local/bin/typst \
 && chmod +x /usr/local/bin/typst

# ── The app's build (dev dependencies stay here) ─────────────────────
FROM node:24.20.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

# ── Production dependencies only ─────────────────────────────────────
FROM node:24.20.0-bookworm-slim AS prod-deps
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ── The runtime ──────────────────────────────────────────────────────
FROM node:24.20.0-bookworm-slim AS runtime

# Fonts; Python for WeasyPrint's venv and the Office theme script; WeasyPrint's Debian libraries; Poppler's pdfinfo
# and pdftoppm; Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      fonts-noto-core fonts-noto-mono fonts-noto-color-emoji \
      python3 python3-venv \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
      poppler-utils \
      chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=typst-bin /usr/local/bin/typst /usr/local/bin/typst

# Pandoc from its GitHub release (Debian's is older than the Typst writer --pdf-engine=typst needs)
ARG PANDOC_VERSION=3.13
ARG PANDOC_SHA256_AMD64=7e3736f255090296ca5d1a14291a76b9b3c43cd385011b1621a4d0c16091a70f
ARG PANDOC_SHA256_ARM64=e55b480eb76997812b44c3f65f641c84214e623bc40b70a6b6d16ee00bfcca23
RUN ARCH=$(dpkg --print-architecture) \
 && case "$ARCH" in \
      amd64) PANDOC_SHA256="$PANDOC_SHA256_AMD64" ;; \
      arm64) PANDOC_SHA256="$PANDOC_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${ARCH}.deb" \
 && echo "$PANDOC_SHA256  /tmp/pandoc.deb" | sha256sum -c - \
 && dpkg -i /tmp/pandoc.deb \
 && rm /tmp/pandoc.deb \
 && pandoc --version | head -1

# Quarto, from its GitHub release
ARG QUARTO_VERSION=1.11.9
ARG QUARTO_SHA256_AMD64=64078d1623d9ab89da766591f3410a0756f3737a37efb0897c7e84b863bf092a
ARG QUARTO_SHA256_ARM64=17aef0c6b02c93a295483063571b5db3315095fe76f4274f286f1f9e44cdac9e
RUN ARCH=$(dpkg --print-architecture) \
 && case "$ARCH" in \
      amd64) QUARTO_SHA256="$QUARTO_SHA256_AMD64" ;; \
      arm64) QUARTO_SHA256="$QUARTO_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/quarto.deb \
      "https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-${ARCH}.deb" \
 && echo "$QUARTO_SHA256  /tmp/quarto.deb" | sha256sum -c - \
 && dpkg -i /tmp/quarto.deb \
 && rm /tmp/quarto.deb \
 && quarto --version

# WeasyPrint in a venv first on the PATH, so `python3` is the venv's (scripts/weasyprint-render.py imports it) and pip
# never touches Debian's Python
ARG WEASYPRINT_VERSION=70.0
RUN python3 -m venv /opt/weasyprint \
 && /opt/weasyprint/bin/pip install --no-cache-dir "weasyprint==${WEASYPRINT_VERSION}" \
 && /opt/weasyprint/bin/weasyprint --version
ENV PATH=/opt/weasyprint/bin:$PATH

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts
COPY templates ./templates

# Typst packages cached at build time; the runtime user can read them and cannot add to them
ENV TYPST_PACKAGE_CACHE_PATH=/app/.typst-packages
RUN mkdir -p "$TYPST_PACKAGE_CACHE_PATH" \
 && printf '%s\n' '#import "@preview/cetz:0.5.3"' '#import "@preview/fletcher:0.5.8"' '= pre-warm' > /tmp/prewarm.typ \
 && typst compile /tmp/prewarm.typ /tmp/prewarm.pdf --package-path "$TYPST_PACKAGE_CACHE_PATH" \
 && rm -f /tmp/prewarm.typ /tmp/prewarm.pdf

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    QUARTO_NO_ANALYTICS=1 \
    FABULA_CHROMIUM_PATH=/usr/bin/chromium \
    FABULA_TEMPLATES_DIR=/app/templates
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3100}/healthz" || exit 1

CMD ["node", "dist/main.js"]
