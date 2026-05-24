import { Router, type IRouter } from "express";
import axios from "axios";
import {
  searchAnime,
  getAnimeDetails,
  getEpisodes,
  getServers,
  getEmbedUrl,
} from "../lib/anime/scraper.js";
import { extractStream } from "../lib/anime/providers/index.js";

const router: IRouter = Router();

/**
 * GET /api/search?q=naruto
 */
router.get("/search", async (req, res): Promise<void> => {
  const q = Array.isArray(req.query["q"]) ? req.query["q"][0] : req.query["q"];
  if (!q || typeof q !== "string") {
    res.status(400).json({ error: "Missing query param: q" });
    return;
  }
  const results = await searchAnime(q);
  res.json({ results });
});

/**
 * GET /api/details?id=naruto-76396
 */
router.get("/details", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const details = await getAnimeDetails(id);
  res.json(details);
});

/**
 * GET /api/episodes?id=naruto-76396
 */
router.get("/episodes", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const episodes = await getEpisodes(id);
  res.json({ episodes });
});

/**
 * GET /api/servers?episodeId=naruto-76396-ep-1&type=sub
 *   OR /api/servers?id=naruto-76396&ep=1&type=sub (legacy)
 * episodeId format: "{animeSlug}-ep-{number}" — carries the anime ID inside
 */
router.get("/servers", async (req, res): Promise<void> => {
  const episodeIdRaw = Array.isArray(req.query["episodeId"])
    ? req.query["episodeId"][0]
    : req.query["episodeId"];
  const idRaw = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"])
    ? req.query["ep"][0]
    : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"])
    ? req.query["type"][0]
    : req.query["type"];

  let animeId: string;
  let ep: number;

  // New format: episodeId = "naruto-76396-ep-1"
  if (episodeIdRaw && typeof episodeIdRaw === "string") {
    const match = episodeIdRaw.match(/^(.+)-ep-(\d+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid episodeId format. Expected: animeSlug-ep-N (e.g. naruto-76396-ep-1)" });
      return;
    }
    animeId = match[1];
    ep = parseInt(match[2], 10);
  }
  // Legacy format: id + ep
  else if (idRaw && typeof idRaw === "string" && epRaw) {
    animeId = idRaw;
    ep = parseInt(String(epRaw), 10);
    if (isNaN(ep)) {
      res.status(400).json({ error: "param ep must be a number" });
      return;
    }
  }
  else {
    res.status(400).json({ error: "Provide either episodeId (e.g. naruto-76396-ep-1) or id + ep" });
    return;
  }

  const type: "sub" | "dub" | "raw" =
    typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const servers = await getServers(animeId, ep, type);
  res.json({ servers });
});

/**
 * GET /api/stream?serverId=<server_id_from_servers_output>&proxy=https://...
 * serverId: the `id` field from /api/servers output — everything is encoded inside
 * proxy: optional proxy URL for DGHG/Turnstile flows
 */
router.get("/stream", async (req, res): Promise<void> => {
  const { serverId } = req.query;
  if (!serverId || typeof serverId !== "string") {
    res.status(400).json({ error: "serverId is required" });
    return;
  }

  const proxyUrl = typeof req.query["proxy"] === "string" ? req.query["proxy"] : null;

  req.log.info({ serverId: serverId.slice(0, 40) }, "stream requested via serverId");

  const sourcesResult = await getEmbedUrl(serverId);
  if (!sourcesResult?.url) {
    res.status(502).json({ error: "Could not resolve embed URL from serverId" });
    return;
  }

  const stream = await extractStream(sourcesResult.url, "direct", {
    intro: sourcesResult.skip_data?.intro,
    outro: sourcesResult.skip_data?.outro,
  }, proxyUrl);

  // If extraction returned null and the embed URL is a DGHG/Turnstile host,
  // return the embed URL directly for client-side playback
  if (!stream) {
    const { isPlaymogoHost } = await import("../lib/anime/providers/dghg.js");
    if (isPlaymogoHost(sourcesResult.url)) {
      res.json({
        type: "dghg_embed",
        embed_url: sourcesResult.url,
        _server: "DGHG",
      });
      return;
    }
    res.status(502).json({ error: "Stream extraction failed from serverId" });
    return;
  }

  if (stream && '_dghgProxy' in stream) {
    const proxyInfo = (stream as Record<string, unknown>)._dghgProxy as {
      url: string; id: string; host: string; resultEndpoint: string; player_url?: string;
    };
    res.json({
      type: "dghg_proxy",
      proxy_url: proxyInfo.url,
      player_url: proxyInfo.player_url,
      video_id: proxyInfo.id,
      host: proxyInfo.host,
      result_endpoint: proxyInfo.resultEndpoint,
      _server: "DGHG",
    });
    return;
  }

  if (stream?.m3u8) {
    res.json({ ...stream, _server: "direct" });
    return;
  }

  res.status(502).json({ error: "Stream extraction failed from serverId" });
});

/**
 * GET /api/dghg/poll?id=videoId&worker=https://...
 * Poll the Cloudflare Worker for the pass_md5 result.
 * Client calls this after opening the proxy URL to check if Turnstile has been solved.
 */
router.get("/dghg/poll", async (req, res): Promise<void> => {
  const videoId = req.query["id"] as string | undefined;
  const workerUrl = req.query["worker"] as string | undefined;

  if (!videoId || !workerUrl) {
    res.status(400).json({ error: "Missing id or worker parameter" });
    return;
  }

  try {
    const result = await axios.get(`${workerUrl}/__dghg_result?id=${encodeURIComponent(videoId)}`, {
      timeout: 5000,
    });
    res.json(result.data);
  } catch (err) {
    res.status(502).json({ error: "Poll failed", reason: (err as Error).message });
  }
});

/**
 * GET /api/dghg/passmd5?url=https://playmogo.com/pass_md5/xxx&referer=https://...
 * Proxy the pass_md5 call (which requires the right Referer/Cookie).
 * Client calls this to get the CDN base URL from the pass_md5 endpoint.
 */
router.get("/dghg/passmd5", async (req, res): Promise<void> => {
  const passMd5Url = req.query["url"] as string | undefined;
  const referer = req.query["referer"] as string || "https://playmogo.com/";

  if (!passMd5Url) {
    res.status(400).json({ error: "Missing url parameter" });
    return;
  }

  try {
    const result = await axios.get(passMd5Url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: referer,
      },
      maxRedirects: 5,
    });

    const cdnUrl = typeof result.data === "string" ? result.data.trim() : result.data;
    res.json({ cdn_url: cdnUrl });
  } catch (err) {
    const e = err as Error & { response?: { status: number; data?: string } };
    res.status(502).json({
      error: "pass_md5 call failed",
      reason: e.message,
      upstream_status: e.response?.status,
    });
  }
});

/**
 * GET /api/player/dghg?id=videoId&host=host
 * Returns an HTML page with HLS player that handles the full DGHG Turnstile flow:
 * 1. Opens a popup/iframe with the Cloudflare Worker proxy page
 * 2. User solves Turnstile (residential IP = easy/no challenge)
 * 3. Injected JS captures pass_md5 → stores in Worker
 * 4. Page polls Worker for result
 * 5. Fetches CDN URL and constructs m3u8
 * 6. Plays stream directly in the HLS player
 */
router.get("/player/dghg", (req, res): void => {
  const videoId = req.query["id"] as string | undefined;
  const host = req.query["host"] as string || "myvidplay.com";

  if (!videoId) {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }

  // Serve the player HTML with the video params injected
  const playerHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stream Player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center}
#player-container{width:100%;max-width:900px;margin:20px}
video{width:100%;display:block;background:#000;min-height:400px;border-radius:8px}
#overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:10}
#overlay.hidden{display:none}
.box{background:#111;border:1px solid #222;border-radius:12px;padding:32px;text-align:center;max-width:420px}
.box .icon{font-size:48px;margin-bottom:16px}
.box .msg{font-size:18px;margin-bottom:8px}
.box .sub{font-size:14px;color:#666}
.box .err{color:#ff4444;font-size:14px;margin-top:12px}
#retry-btn{background:#00d4ff;color:#000;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;margin-top:16px}
#retry-btn:hover{background:#00b8e6}
</style>
</head>
<body>
<div id="player-container">
  <div id="overlay">
    <div class="box">
      <div class="icon" id="icon">🔐</div>
      <div class="msg" id="msg">Loading stream...</div>
      <div class="sub" id="sub">Preparing Turnstile verification</div>
      <div class="err" id="err"></div>
      <button id="retry-btn" onclick="location.reload()" style="display:none">Retry</button>
    </div>
  </div>
  <video id="video" controls playsinline style="display:none;border-radius:8px;overflow:hidden"></video>
</div>
<script>
(function(){
  const videoId = '${videoId}';
  const host = '${host}';
  const WORKER = 'https://dghg-proxy.${process.env.CF_ACCOUNT_DOMAIN || 'lk5029716.workers.dev'}';
  const PROXY_URL = WORKER + '/?id=' + encodeURIComponent(videoId) + '&host=' + encodeURIComponent(host);
  const RESULT_URL = WORKER + '/__dghg_result?id=' + encodeURIComponent(videoId);

  function setUI(icon, msg, sub, err, showRetry){
    document.getElementById('icon').textContent = icon;
    document.getElementById('msg').textContent = msg;
    document.getElementById('sub').textContent = sub || '';
    document.getElementById('err').textContent = err || '';
    document.getElementById('retry-btn').style.display = showRetry ? 'inline-block' : 'none';
  }

  function hideOverlay(){ document.getElementById('overlay').classList.add('hidden'); }
  function showVideo(){ document.getElementById('video').style.display='block'; }

  async function getCDN(passMd5Url, token){
    setUI('📡','Fetching CDN URL...','This should take a second');
    try {
      const r = await fetch('https://' + host + '/' + passMd5Url, {
        headers:{'Referer':'https://' + host + '/e/' + videoId}
      });
      const url = (await r.text()).trim();
      if(!url.startsWith('http')) throw new Error('Invalid CDN response');
      return url;
    } catch(e){
      throw new Error('CDN fetch failed: ' + e.message);
    }
  }

  function buildM3u8(cdnUrl, token){
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for(let i=0;i<10;i++) s += chars.charAt(Math.floor(Math.random()*chars.length));
    return cdnUrl + s + '?token=' + token + '&expiry=' + Date.now();
  }

  function playM3u8(url){
    const video = document.getElementById('video');
    if(Hls.isSupported()){
      const hls = new Hls({enableWorker:true,lowLatencyMode:true});
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, ()=>{
        hideOverlay(); showVideo();
        video.play().catch(()=>{});
      });
      hls.on(Hls.Events.ERROR, (e,d)=>{
        if(d.fatal){ hideOverlay(); setUI('❌','Playback error','Failed to load video stream',d.type,true); }
      });
    } else if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src = url;
      video.addEventListener('loadedmetadata', ()=>{ hideOverlay(); showVideo(); video.play().catch(()=>{}); });
    } else {
      setUI('❌','Browser not supported','Your browser cannot play HLS streams', '', true);
    }
  }

  // Start flow
  setUI('🔐','Solving Turnstile...','A new window opened — complete the challenge there');

  // Open popup for Turnstile
  const popup = window.open(PROXY_URL,'dghg_popup','width=520,height=580,left='+((screen.width-520)/2)+',top='+((screen.height-580)/2));

  if(!popup){
    // Popup blocked — use redirect approach
    setUI('🔐','Please solve the Click below to continue','');
    const btn = document.createElement('button');
    btn.id='retry-btn';
    btn.textContent='Open Turnstile Page';
    btn.style.display='inline-block';
    btn.onclick = ()=>{
      window.open(PROXY_URL,'dghg_popup','width=520,height=580');
      btn.style.display='none';
      startPoll();
    };
    document.querySelector('.box').appendChild(btn);
    return; // wait for user click
  }

  startPoll();

  let polls = 0;
  function startPoll(){
    setUI('⏳','Waiting for Turnstile...','Solve the challenge in the popup window');
    const iv = setInterval(async()=>{
      polls++;
      if(polls > 180){ // 3 min
        clearInterval(iv);
        setUI('⏰','Timed out','Turnstile was not solved in time','',true);
        return;
      }
      try{
        const r = await fetch(RESULT_URL);
        const d = await r.json();
        if(d.status==='done'){
          clearInterval(iv);
          const passMd5 = d.passMd5Url;
          const token = passMd5.split('/').pop();
          try{
            const cdn = await getCDN(passMd5, token);
            const m3u8 = buildM3u8(cdn, token);
            playM3u8(m3u8);
          } catch(e){
            clearInterval(iv);
            setUI('❌','Failed to get CDN URL',e.message,'',true);
          }
        }
      } catch(e){ /* not ready, keep polling */ }
    },1000);
  }
})();
<\/script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(playerHtml);
});

/**
 * GET /api/proxy?url=https://...&referer=https://...
 */
router.get("/proxy", async (req, res): Promise<void> => {
  const urlParam = Array.isArray(req.query["url"])
    ? req.query["url"][0]
    : req.query["url"];
  const refererParam = Array.isArray(req.query["referer"])
    ? req.query["referer"][0]
    : req.query["referer"];

  if (!urlParam || typeof urlParam !== "string") {
    res.status(400).json({ error: "Missing query param: url" });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  let referer = typeof refererParam === "string" ? refererParam : null;
  if (!referer) {
    const host = targetUrl.hostname;
    if (host.includes("echovideo") || host.includes("echo")) {
      referer = "https://play.echovideo.ru/";
    } else if (host.includes("weneverbeenfree") || host.includes("owphbf") || host.includes("sprintcdn")) {
      referer = "https://weneverbeenfree.com/";
    } else if (host.includes("playmogo") || host.includes("doodcdn") || host.includes("doodstream") || host.includes("cloudatacdn")) {
      referer = "https://playmogo.com/";
    } else {
      referer = "https://play.echovideo.ru/";
    }
  }

  req.log.info(
    { url: urlParam.slice(0, 80), referer },
    "proxying stream URL"
  );

  try {
    const upstream = await axios.get(urlParam, {
      responseType: "stream",
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: "*/*",
        "Accept-Encoding": "identity",
      },
      maxRedirects: 5,
    });

    const contentType = upstream.headers["content-type"] as string | undefined;
    const contentLength = upstream.headers["content-length"] as string | undefined;

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");

    if (contentType?.includes("mpegurl") || urlParam.includes(".m3u8")) {
      const chunks: Buffer[] = [];
      upstream.data.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstream.data.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const encodedReferer = encodeURIComponent(referer ?? "https://play.echovideo.ru/");
        const baseUrl = urlParam.substring(0, urlParam.lastIndexOf("/") + 1);

        const rewritten = body
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
                const abs = uri.startsWith("http") ? uri : baseUrl + uri;
                return `URI="/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
              });
            }
            if (trimmed.startsWith("#")) return line;
            const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
            return `/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
          })
          .join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.removeHeader("Content-Length");
        res.send(rewritten);
      });
      upstream.data.on("error", () => {
        if (!res.headersSent) res.status(502).json({ error: "upstream stream error" });
      });
    } else {
      upstream.data.pipe(res);
    }
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    req.log.error(
      { url: urlParam.slice(0, 80), error: e.message, status: e.response?.status },
      "proxy request failed"
    );
    if (!res.headersSent) {
      res.status(502).json({
        error: "Proxy failed",
        reason: e.message,
        upstreamStatus: e.response?.status ?? null,
      });
    }
  }
});

// Comprehensive DGHG diagnostic: clicks play, tracks Turnstile, waits for reload
router.get("/debug/dghg-full", async (req, res): Promise<void> => {
  const linkId = req.query["linkId"] as string | undefined;
  if (!linkId) { res.status(400).json({ error: "Missing linkId" }); return; }

  const logs: string[] = [];
  const log = (msg: string) => logs.push(`[${new Date().toISOString()}] ${msg}`);

  try {
    const { getEmbedUrl } = await import("../lib/anime/scraper.js");
    const sourcesResult = await getEmbedUrl(linkId);
    if (!sourcesResult?.url) { res.status(502).json({ error: "no embed URL", logs }); return; }

    const embedUrl = sourcesResult.url;
    log(`embedUrl: ${embedUrl}`);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Referer: "https://aniwaves.ru/" },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();

    const allRequests: {method: string, url: string, time: number}[] = [];
    page.on("request", (req) => {
      const entry = { method: req.method(), url: req.url().slice(0, 150), time: Date.now() };
      allRequests.push(entry);
      if (req.url().includes("/dood") || req.url().includes("turnstile") || req.url().includes(".m3u8") || req.url().includes("pass_md5")) {
        log(`REQUEST: ${req.method()} ${req.url().slice(0, 120)}`);
      }
    });

    const allResponses: {status: number, url: string, time: number}[] = [];
    page.on("response", (resp) => {
      const entry = { status: resp.status(), url: resp.url().slice(0, 150), time: Date.now() };
      allResponses.push(entry);
      if (resp.url().includes("/dood") || resp.url().includes("turnstile")) {
        log(`RESPONSE: ${resp.status()} ${resp.url().slice(0, 120)}`);
      }
    });

    // Navigate
    log("navigating to embed page...");
    const navResp = await page.goto(embedUrl, { waitUntil: "networkidle", timeout: 60000 }).catch(async () => {
      log("networkidle timeout, trying domcontentloaded...");
      return page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    });

    log(`page loaded: status=${navResp?.status()}, url=${page.url()}, htmlLen=${(await page.content()).length}`);

    // Wait for initial page to settle
    await page.waitForTimeout(5000);
    let html = await page.content();
    const urlAfterLoad = page.url();
    log(`after 5s wait: url=${urlAfterLoad}, htmlLen=${html.length}`);
    log(`has Turnstile: ${html.toLowerCase().includes("turnstile")}`);
    log(`has pass_md5: ${html.includes("pass_md5")}`);
    log(`has /dood endpoint call: ${allRequests.some(r => r.url.includes("/dood"))}`);

    // Click play button
    log("clicking play button...");
    const clickResult = await page.evaluate(() => {
      const selectors = [".captcha_l", ".vjs-big-play-button", "button.vjs-big-play-button"];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) { el.click(); return `clicked: ${sel}`; }
      }
      const vp = document.getElementById("video_player") as HTMLElement;
      if (vp) { vp.click(); return "clicked: #video_player"; }
      return "no play button found";
    });
    log(`click result: ${clickResult}`);

    // Wait for Turnstile to solve and page to reload
    log("waiting 45s for Turnstile solve + reload...");
    const waitStart = Date.now();
    let passMd5Found: string | null = null;
    let foundAt = 0;
    let reloadCount = 0;
    let lastUrl = page.url();

    while (Date.now() - waitStart < 45000) {
      await page.waitForTimeout(2000);
      html = await page.content().catch(() => "");
      const currentUrl = page.url();

      if (currentUrl !== lastUrl) {
        reloadCount++;
        log(`URL CHANGED (#${reloadCount}): ${currentUrl}`);
        lastUrl = currentUrl;
      }

      const m = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
      if (m) {
        passMd5Found = m[1];
        foundAt = Date.now() - waitStart;
        log(`✓ pass_md5 FOUND after ${Math.round(foundAt/1000)}s: ${passMd5Found}`);
        break;
      }

      // Alt check
      if (html.length > 7000) {
        const alt = html.match(/pass_md5\/([^'"\s,\]]+)/);
        if (alt && !alt[0].includes("function")) {
          passMd5Found = alt[1];
          foundAt = Date.now() - waitStart;
          log(`✓ pass_md5 FOUND (alt) after ${Math.round(foundAt/1000)}s: ${passMd5Found}`);
          break;
        }
      }
    }

    const totalTime = Date.now() - waitStart;

    // Gather final state
    html = await page.content();
    const finalUrl = page.url();
    const doodRequests = allRequests.filter(r => r.url.includes("/dood"));
    const turnstileRequests = allRequests.filter(r => r.url.includes("turnstile"));

    await browser.close();

    res.json({
      embedUrl,
      finalUrl,
      htmlLen: html.length,
      passMd5: passMd5Found,
      foundAt: foundAt ? `${foundAt}ms` : null,
      totalWait: `${totalTime}ms`,
      reloadCount,
      doodRequestCount: doodRequests.length,
      doodRequests: doodRequests.map(r => `${r.method} ${r.url}`),
      turnstileRequestCount: turnstileRequests.length,
      clickedPlay: clickResult,
      hasTurnstileInHtml: html.toLowerCase().includes("turnstile"),
      hasPassMd5: html.includes("pass_md5"),
      logs,
      allRequests: allRequests.map(r => `${r.method} ${r.url}`).slice(0, 50),
    });
  } catch (err) {
    log(`ERROR: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message, logs });
  }
});

// DGHG Turnstile bypass attempt — intercept pass_md5 token from page JS
router.get("/debug/dghg-bypass", async (req, res): Promise<void> => {
  const linkId = req.query["linkId"] as string | undefined;
  if (!linkId) { res.status(400).json({ error: "Missing linkId" }); return; }

  const logs: string[] = [];
  const log = (msg: string) => logs.push(`[${new Date().toISOString()}] ${msg}`);

  try {
    const { getEmbedUrl } = await import("../lib/anime/scraper.js");
    const sourcesResult = await getEmbedUrl(linkId);
    if (!sourcesResult?.url) { res.status(502).json({ error: "no embed URL", logs }); return; }

    const embedUrl = sourcesResult.url;
    log(`embedUrl: ${embedUrl}`);

    const urlObj = new URL(embedUrl);
    const videoId = urlObj.pathname.split("/").pop() || "";
    const host = urlObj.hostname;
    log(`videoId: ${videoId}, host: ${host}`);

    const pw = await import("playwright");
    const browser = await pw.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Referer: "https://aniwaves.ru/" },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();

    // Intercept pass_md5 responses
    let cdnBaseUrl: string | null = null;
    let passMd5Path: string | null = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/pass_md5/")) {
        try {
          const text = await response.text();
          cdnBaseUrl = text.trim();
          const m = url.match(/\/pass_md5\/(.+)/);
          if (m) passMd5Path = m[1];
          log(`PASS_MD5: path=${passMd5Path}, cdn=${cdnBaseUrl.slice(0,100)}`);
        } catch (e) { /* ignore */ }
      }
    });

    // Navigate
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    let html = await page.content();

    // Check initial HTML for pass_md5
    const initialMatch = html.match(/pass_md5\/([^'"\s,\]]+)/);
    if (initialMatch) log(`pass_md5 in initial HTML: ${initialMatch[1]}`);

    // Extract ALL JS from page to find token generation logic
    const jsCode = await page.evaluate(() => {
      const scripts = document.querySelectorAll("script");
      let allJS = "";
      for (const s of scripts) {
        allJS += (s.textContent || "") + "\n---\n";
      }
      return allJS;
    });
    log(`Total JS length: ${jsCode.length}`);

    // Look for token/key/secret in JS
    const tokenMatches = jsCode.match(/(?:token|key|secret|pass_md5|rand_str|expiry)["'\s:=]+["']?([a-zA-Z0-9_-]{10,})["']?/gi);
    if (tokenMatches) log(`Token patterns: ${tokenMatches.slice(0,5).join(" | ")}`);

    // Look for the captcha_l click handler — it contains the Turnstile callback
    const captchaHandler = jsCode.match(/\.captcha_l[\s\S]{0,500}/);
    if (captchaHandler) log(`Captcha handler: ${captchaHandler[0].slice(0, 300)}`);

    // Try to find the /dood endpoint call pattern
    const doodPattern = jsCode.match(/\/dood[^\s"'`]+/g);
    if (doodPattern) log(`Dood endpoints: ${doodPattern.join(", ")}`);

    // Try clicking play
    const playBtn = await page.$(".captcha_l") || await page.$("#video_player");
    if (playBtn) {
      await playBtn.click();
      log("clicked play");
    }

    // INTERCEPT: Fake the Turnstile validation
    await page.route("**/dood?op=validate*", async (route) => {
      log("INTERCEPTED /dood?op=validate — returning fake success");
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "ok",
      });
    });

    // Wait 15s for Turnstile + reload
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      html = await page.content();
      const m = html.match(/pass_md5\/([^'"\s,\]]+)/);
      if (m) {
        passMd5Path = m[1];
        log(`pass_md5 found at ${i+1}s: ${passMd5Path}`);
        break;
      }
    }

    // If we got pass_md5, call it
    if (passMd5Path && !cdnBaseUrl) {
      const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
      log(`Calling pass_md5: ${passMd5Url}`);
      const passResp = await page.evaluate(async (url: string) => {
        const r = await fetch(url);
        return r.text();
      }, passMd5Url);
      cdnBaseUrl = passResp.trim();
      log(`CDN base: ${cdnBaseUrl.slice(0, 100)}`);
    }

    await browser.close();
    res.json({
      logs,
      videoId,
      host,
      embedUrl,
      passMd5Path,
      cdnBaseUrl,
      success: !!(passMd5Path && cdnBaseUrl),
    });
  } catch (err) {
    log(`ERROR: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message, logs });
  }
});

export default router;
