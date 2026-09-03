FROM node:22-alpine AS build

WORKDIR /app
COPY video-handler-worker/package.json video-handler-worker/package-lock.json ./video-handler-worker/
WORKDIR /app/video-handler-worker
RUN npm ci
WORKDIR /app
COPY video-handler-worker/tsconfig.json ./video-handler-worker/
COPY video-handler-worker/src ./video-handler-worker/src
RUN npm --prefix video-handler-worker run build

FROM node:22-alpine

WORKDIR /app/video-handler-worker
ENV NODE_ENV=production
ENV TMPDIR=/tmp
RUN apk add --no-cache ffmpeg
COPY video-handler-worker/package.json video-handler-worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/video-handler-worker/dist /app/video-handler-worker/dist
USER node
CMD ["node", "dist/index.js"]
