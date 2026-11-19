FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY seed ./seed
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server/index.js"]
