# BioPassport V2 Services Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Expose API port
EXPOSE 3000

# Default command (override in docker-compose)
CMD ["node", "dist/api.js"]
