FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN npm install -g pnpm@11.24.0 && NODE_OPTIONS=--max-old-space-size=512 pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1 && pnpm run build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV CEREBRA_ADDRESS=http://localhost:4317
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/agent-types ./packages/backend/agent-types
COPY --from=build /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
RUN npm install -g pnpm@11.24.0 && NODE_OPTIONS=--max-old-space-size=512 pnpm install --prod --frozen-lockfile --network-concurrency=4 --child-concurrency=1
EXPOSE 4317
CMD ["node", "packages/backend/dist/main.js"]
