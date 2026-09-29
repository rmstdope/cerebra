FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile && pnpm run build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV CEREBRA_ADDRESS=http://localhost:4317
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/agent-types ./packages/backend/agent-types
COPY --from=build /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
RUN corepack enable && pnpm install --prod --frozen-lockfile
EXPOSE 4317
CMD ["node", "packages/backend/dist/main.js"]
