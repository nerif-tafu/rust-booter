FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js ./

EXPOSE 8534
ENV NODE_ENV=production
ENV PORT=8534

CMD ["node", "server.js"]
