FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY angular.json tsconfig.app.json tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/video-handler-client/browser /usr/share/nginx/html

EXPOSE 80
