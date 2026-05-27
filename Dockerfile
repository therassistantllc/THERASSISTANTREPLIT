FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable
RUN corepack prepare pnpm@10.32.1 --activate

WORKDIR /workspace

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json replit.md ./

RUN pnpm install --frozen-lockfile

FROM deps AS build

RUN pnpm -C artifacts/therassistant-ehr build

FROM node:24-slim AS runner

ENV NODE_ENV=production
ENV PORT=8080
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable
RUN corepack prepare pnpm@10.32.1 --activate

WORKDIR /workspace

COPY --from=deps /workspace/package.json ./package.json
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/.npmrc ./
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/artifacts ./artifacts
COPY --from=deps /workspace/lib ./lib
COPY --from=deps /workspace/scripts ./scripts
COPY --from=deps /workspace/tsconfig.base.json ./tsconfig.base.json
COPY --from=deps /workspace/tsconfig.json ./tsconfig.json
COPY --from=build /workspace/artifacts/therassistant-ehr/.next ./artifacts/therassistant-ehr/.next
COPY --from=build /workspace/artifacts/therassistant-ehr/public ./artifacts/therassistant-ehr/public

EXPOSE 8080

CMD ["sh", "-c", "pnpm -C artifacts/therassistant-ehr start"]