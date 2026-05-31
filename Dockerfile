FROM node:22-slim

# Install Python3 + create venv + install curl_cffi (all in one layer)
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    libffi-dev \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir curl_cffi beautifulsoup4 \
 && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY package*.json ./
RUN npm install && npx playwright install chromium

COPY . .
RUN npm run build

ENV ANIWAVES_SCRAPER_PATH=/app/aniwaves_scraper.py

EXPOSE 3000
CMD ["node", "dist/index.mjs"]
