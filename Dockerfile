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
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium-1080/chrome-linux/chrome

CMD ["node", "dist/index.mjs"]
