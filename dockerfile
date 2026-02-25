FROM node:20-alpine

WORKDIR /app

# instala deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# copia o resto
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
