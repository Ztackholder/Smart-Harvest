FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_DEFAULT_PERIOD=2026-W48
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_DEFAULT_PERIOD=$VITE_DEFAULT_PERIOD
RUN npm run build
FROM nginx:1.27.4-alpine
COPY infrastructure/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
