# Render's default Node runtime doesn't include poppler-utils, which
# render.js needs (it shells out to pdftoppm to rasterize each page of a
# purchased PDF at upload time — see docs/closed-reader-build-brief.md §3).
# Deploying from this Dockerfile instead of the native Node runtime is what
# makes that binary available in production.
#
# On Render: New -> Web Service -> connect the repo -> Render should detect
# this Dockerfile automatically (or set the environment to "Docker" if
# asked). No separate build/start command is needed; CMD below covers it.

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
