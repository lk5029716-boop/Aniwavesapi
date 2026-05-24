FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package.json build.mjs ./
COPY src/ ./src/
COPY frontend/ ./frontend/

RUN npm install --ignore-scripts

RUN node build.mjs

EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "dist/index.mjs"]
# Cache bust 1779575000
