FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-slim AS web-build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY web ./web
RUN npm run build:web

FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY src ./src
COPY --from=web-build /app/dist ./dist

EXPOSE 8085

CMD ["npm", "start"]
