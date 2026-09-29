FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN npm install -g pnpm@11.24.0 && pnpm install --frozen-lockfile && pnpm exec tsc -b packages/runner

FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gh \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/runner/dist ./packages/runner/dist
COPY --from=build /app/packages/runner/package.json ./packages/runner/package.json
# The Claude Agent SDK brings the Claude CLI as a native binary for this platform.
RUN npm install -g pnpm@11.24.0 && pnpm install --prod --frozen-lockfile \
  && mkdir -p /work /cli-state /home/agent \
  && chown 1000:1000 /work /cli-state /home/agent
ENV HOME=/home/agent
ENV CLAUDE_CONFIG_DIR=/cli-state
USER 1000:1000
WORKDIR /work
CMD ["node", "/app/packages/runner/dist/main.js"]
