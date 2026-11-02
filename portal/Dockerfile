FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
# uid 1000, the same uid n8n writes citizen evidence into the shared complaint_media volume with
USER node
EXPOSE 3001
CMD ["node", "src/server.js"]
