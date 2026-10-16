FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

ENV NODE_ENV=production
USER pwuser
CMD ["npm", "run", "worker"]
