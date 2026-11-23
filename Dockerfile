# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Test image: full dev dependencies + sources; runs the suite against the compose database.
FROM deps AS test
COPY tsconfig.json tsconfig.build.json vitest.config.mts ./
COPY src ./src
COPY migrations ./migrations
COPY test ./test
COPY fixtures ./fixtures
CMD ["npm", "test"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime image: production dependencies and compiled JS only, non-root user.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
# Migrations are idempotent and lock-protected, so running them on every start is safe.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
