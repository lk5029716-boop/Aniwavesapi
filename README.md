# Aniwaves API

Anime streaming API for aniwaves.ru — search, details, episodes, servers, and stream extraction.

## Servers Supported

| Server | Method | Status |
|---|---|---|
| Vidplay | HTTP (RC4/AES decryption) | ✅ |
| BYFMS (WeneverBeenFree) | Playwright headless browser | ✅ |
| DGHG (PlayMogo/DoodStream) | HTTP (pass_md5) | ✅ |

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=naruto` | Search anime |
| `GET /api/details?id=naruto-76396` | Get anime details |
| `GET /api/episodes?id=naruto-76396` | Get episode list |
| `GET /api/servers?id=naruto-76396&ep=1&type=sub` | Get servers for episode |
| `GET /api/stream?id=naruto-76396&ep=1&type=sub&server=vidplay` | Get stream URL |
| `GET /api/proxy?url=...&referer=...` | Proxy stream segments |
| `GET /api/health` | Health check |

## Deploy on Render

1. Create new Web Service, connect this repo
2. Build Command: `npm install && npm run build`
3. Start Command: `npm start`
4. Add environment variable: `PORT=3000`
