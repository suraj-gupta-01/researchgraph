# ---- dev: Vite dev server with hot reload (docker-compose.dev.yml) ---------
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# VITE_API_URL is read at start-up from the environment.
CMD ["npm", "run", "dev"]

# ---- build: typecheck + production bundle ----------------------------------
FROM dev AS build
# The address the *browser* uses to reach the API; baked into the bundle, so
# it is a build argument, not a runtime variable. Never put secrets here:
# everything under VITE_ ships to every visitor.
ARG VITE_API_URL=http://localhost:8000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ---- prod: static files behind nginx, with a strict CSP (the demo default) -
FROM nginx:1.27-alpine AS prod
# nginx's image renders /etc/nginx/templates/*.template with envsubst at
# start-up; API_ORIGIN fills the CSP's connect-src.
ENV API_ORIGIN=http://localhost:8000
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
