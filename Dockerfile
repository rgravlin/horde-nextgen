# syntax=docker/dockerfile:1

# Neon Horde in a container. Two stages, no server-side runtime:
#
#   build  `tsc --noEmit && vite build` -> /app/dist
#   serve  nginx serving that bundle on :8080
#
# The game still *renders* in a browser on the host. A container has no GPU, so
# anything viewed through the published port is on the WebGL2/SwiftShader path at
# best; see README "Docker" for what that does and does not prove.
#
#   docker build -t horde:web .
#   docker run --rm -p 8080:8080 horde:web
#
# For the bind-mounted dev server and the checks runner, see docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app

# Deps first, source second: editing a .ts file must not reinstall three.js.
# The npm cache lives in a BuildKit cache mount so repeat builds stay offline.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.29-alpine AS serve
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1