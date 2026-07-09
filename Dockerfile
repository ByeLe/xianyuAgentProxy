FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

EXPOSE 7892

CMD ["npm", "start"]
