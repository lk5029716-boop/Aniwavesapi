FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Copy project files
COPY package.json build.mjs ./
COPY src/ ./src/
COPY frontend/ ./frontend/
COPY render.yaml ./

# Install dependencies
RUN npm install --ignore-scripts

# Build
RUN node build.mjs

EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "dist/index.mjs"]
