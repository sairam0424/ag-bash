# Ag-Bash MCP server — container image for the Docker MCP Catalog.
#
# Strategy: install the PUBLISHED, version-pinned npm package rather than
# rebuilding the pnpm monorepo + WASM in-container. The mcp-server bundle
# externalizes native/WASM deps (sql.js, quickjs-emscripten, @mongodb-js/zstd,
# node-liblzma, seek-bzip); `npm install @ag-bash/mcp-server` resolves them all,
# including the native addons (which is why we use a fuller base, NOT distroless).
#
# Pin AG_BASH_VERSION at build time to the release you are publishing to the catalog:
#   docker build --build-arg AG_BASH_VERSION=6.0.2 -t ag-bash-mcp .

# ---- build stage: install the package + production deps into a clean prefix ----
FROM node:22-bookworm-slim AS build

ARG AG_BASH_VERSION=6.0.2

# Build toolchain for any native addon that needs compilation (node-liblzma, zstd).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ag-bash
RUN npm init -y >/dev/null 2>&1 \
    && npm install --omit=dev --no-audit --no-fund "@ag-bash/mcp-server@${AG_BASH_VERSION}"

# ---- runtime stage: copy the resolved node_modules, drop the build toolchain ----
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Ag-Bash MCP Server" \
      org.opencontainers.image.description="Sandboxed AI-native bash environment with 70 agentic tools over the Model Context Protocol (stdio)." \
      org.opencontainers.image.source="https://github.com/sairam0424/ag-bash" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production

# Non-root: the MCP server never needs host root and the sandbox is in-process.
RUN useradd --create-home --shell /usr/sbin/nologin agbash
WORKDIR /home/agbash/app

COPY --from=build /opt/ag-bash/node_modules ./node_modules

USER agbash

# stdio JSON-RPC transport — Claude Desktop / Cursor / the MCP Catalog speak to it over stdin/stdout.
ENTRYPOINT ["node", "node_modules/@ag-bash/mcp-server/dist/index.js"]
