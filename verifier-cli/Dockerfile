FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Link CLI globally
RUN npm link

# Default command
ENTRYPOINT ["biopassport"]
CMD ["--help"]
