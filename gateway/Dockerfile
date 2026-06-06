FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/audio-cache

EXPOSE 3000
CMD ["npm", "start"]

