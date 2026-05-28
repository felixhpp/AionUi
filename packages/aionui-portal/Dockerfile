FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY src ./src

EXPOSE 8085

CMD ["npm", "start"]
