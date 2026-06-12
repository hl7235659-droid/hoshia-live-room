FROM node:22-alpine

WORKDIR /app
ARG SOURCE_REVISION=unknown
ENV SOURCE_REVISION=$SOURCE_REVISION
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/audio-cache /app/data

EXPOSE 3000
CMD ["npm", "start"]
