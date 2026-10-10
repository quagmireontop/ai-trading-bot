FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Mount a persistent volume here so activity and bot state survive restarts.
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/server.js"]
