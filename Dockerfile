FROM node:22-slim

# Install Python + curl_cffi
RUN apt-get update && apt-get install -y python3 python3-pip && \
    pip3 install curl_cffi beautifulsoup4 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

ENV ANIWAVES_SCRAPER_PATH=/app/aniwaves_scraper.py
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
