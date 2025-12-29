FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

# Copy source
COPY . .

# Prisma client (build-time)
RUN npx prisma generate

# Build React Router app
RUN npm run build

# Start server only (migrations happen in Render Pre-Deploy)
CMD ["npm", "run", "start"]
