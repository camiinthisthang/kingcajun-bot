FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-dashboard/vendor ./admin-dashboard/vendor
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY admin-dashboard/src ./admin-dashboard/src
COPY admin-dashboard/public ./admin-dashboard/public
COPY admin-dashboard/public/operations-view.js ./admin-dashboard/public/operations-view.js
COPY admin-dashboard/public/payment-view.js ./admin-dashboard/public/payment-view.js
COPY admin-dashboard/public/location-utils.js ./admin-dashboard/public/location-utils.js
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build && mkdir -p dist/src/db && cp src/db/schema.sql dist/src/db/schema.sql

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV FAST_CHECKOUT_ENABLED=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-dashboard/vendor ./admin-dashboard/vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --chown=node:node assets ./assets
USER node
CMD ["npm", "start"]
