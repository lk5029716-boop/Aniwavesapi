// src/app.ts
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";

// src/routes/index.ts
import { Router as Router3 } from "express";

// src/routes/health.ts
import { Router } from "express";
var router = Router();
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
var health_default = router;

// src/routes/anime.ts
import { Router as Router2 } from "express";
import axios4 from "axios";

// src/lib/anime/scraper.ts
import axios from "axios";
import * as cheerio from "cheerio";

// src/lib/anime/cache.ts
import NodeCache from "node-cache";
var cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
function cacheGet(key) {
  return cache.get(key);
}
function cacheSet(key, value, ttl) {
  cache.set(key, value, ttl ?? 300);
}

// src/lib/anime/scraper.ts
var BASE_URL = "https://aniwaves.ru";
var client = axios.create({
  baseURL: BASE_URL,
  timeout: 15e3,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }
});
var ajaxClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15e3,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: BASE_URL
  }
});
async function searchAnime(q) {
  const cacheKey = `search:${q}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const resp = await ajaxClient.get("/ajax/anime/search", {
    params: { keyword: q }
  });
  const data = resp.data;
  const html = typeof data.result === "string" ? data.result : data.result?.html ?? "";
  if (!html) return [];
  const $ = cheerio.load(html);
  const results = [];
  $("a.item").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") ?? "";
    const id = href.replace(/^\/watch\//, "").replace(/\/$/, "");
    const title = $el.find(".name.d-title").text().trim() || $el.find(".name").text().trim();
    const poster = $el.find(".poster img").attr("src") || $el.find(".poster img").attr("data-src") || "";
    const metaDots = $el.find(".meta .dot");
    const type = metaDots.eq(0).text().trim();
    if (id && title) {
      results.push({ id, title, poster, type, episodes: { sub: 0, dub: 0 } });
    }
  });
  cacheSet(cacheKey, results, 300);
  return results;
}
async function getNumericId(animeId) {
  const cacheKey = `numericId:${animeId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const resp = await client.get(`/watch/${animeId}`);
  const $ = cheerio.load(resp.data);
  const numericId = $("[data-id]").first().attr("data-id") ?? null;
  if (numericId) cacheSet(cacheKey, numericId, 86400);
  return numericId;
}
async function getAnimeDetails(id) {
  const cacheKey = `details:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const resp = await client.get(`/watch/${id}`);
  const $ = cheerio.load(resp.data);
  const title = $("h1.title.d-title").text().trim() || $("h1.film-name").text().trim() || $("h1").first().text().trim() || id;
  const poster = $(".poster img").first().attr("src") || $(".film-poster img").attr("src") || "";
  const description = $(".description").text().trim() || $("[itemprop='description']").text().trim();
  const genres = [];
  $("a[href*='/genre/'], a[href*='/genres/']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });
  let subCount = 0;
  let dubCount = 0;
  let totalCount = 0;
  $(".tick-sub, .sub-count").each((_, el) => {
    subCount = parseInt($(el).text().trim(), 10) || subCount;
  });
  $(".tick-dub, .dub-count").each((_, el) => {
    dubCount = parseInt($(el).text().trim(), 10) || dubCount;
  });
  $(".tick-eps, .ep-count").each((_, el) => {
    totalCount = parseInt($(el).text().trim(), 10) || totalCount;
  });
  const filmInfoMap = {};
  $("div").each((_, el) => {
    const text = $(el).clone().children("span").remove().end().text().trim();
    const cleanLabel = text.replace(/:\s*$/, "").trim().toLowerCase();
    if (!cleanLabel || cleanLabel.length > 30) return;
    const val = $(el).find("span").first().text().trim();
    if (val) filmInfoMap[cleanLabel] = val;
  });
  const genreDiv = $("div").filter((_, el) => {
    return $(el).clone().children().remove().end().text().trim().startsWith("Genres:");
  }).first();
  if (genreDiv.length) {
    genres.length = 0;
    genreDiv.find("a").each((_, el) => {
      const t = $(el).text().trim();
      if (t) genres.push(t);
    });
  }
  const episodeText = filmInfoMap["episodes"] ?? "";
  const epMatch = episodeText.match(/(\d+)/g);
  if (epMatch) {
    totalCount = parseInt(epMatch[0] ?? "0", 10) || totalCount;
  }
  const mainType = $("span.wa_type").first().text().trim();
  const details = {
    id,
    title,
    poster,
    description,
    type: mainType || filmInfoMap["type"] || filmInfoMap["format"] || "Unknown",
    status: filmInfoMap["status"] ?? "Unknown",
    aired: $("[itemprop='dateCreated']").text().trim() || filmInfoMap["date aired"] || filmInfoMap["aired"] || filmInfoMap["premiered"] || "Unknown",
    genres,
    episodes: {
      sub: subCount || totalCount,
      dub: dubCount,
      total: totalCount || subCount
    }
  };
  cacheSet(cacheKey, details, 1800);
  return details;
}
async function getEpisodes(animeId) {
  const cacheKey = `episodes:${animeId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const numericId = await getNumericId(animeId);
  if (!numericId) return [];
  const resp = await ajaxClient.get(`/ajax/episode/list/${numericId}`, {
    headers: { Referer: `${BASE_URL}/watch/${animeId}` }
  });
  const data = resp.data;
  const html = data.result ?? "";
  if (!html) return [];
  const $ = cheerio.load(html);
  const episodes = [];
  $("a[data-ids][data-num]").each((_, el) => {
    const $el = $(el);
    const dataIds = $el.attr("data-ids") ?? "";
    const num = parseInt($el.attr("data-num") ?? "0", 10);
    const title = $el.attr("title") || null;
    const isFiller = $el.hasClass("filler");
    if (dataIds && num > 0) {
      episodes.push({ number: num, id: dataIds, title, isFiller });
    }
  });
  episodes.sort((a, b) => a.number - b.number);
  cacheSet(cacheKey, episodes, 600);
  return episodes;
}
async function getServers(animeId, ep, type) {
  const cacheKey = `servers:${animeId}:${ep}:${type}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const episodes = await getEpisodes(animeId);
  const episode = episodes.find((e) => e.number === ep);
  if (!episode) return [];
  const [animeNumId, epsNum] = episode.id.split("&eps=");
  const resp = await ajaxClient.get("/ajax/server/list", {
    params: { servers: animeNumId, eps: epsNum },
    headers: { Referer: `${BASE_URL}/watch/${animeId}` }
  });
  const data = resp.data;
  const html = data.result ?? "";
  if (!html) return [];
  const $ = cheerio.load(html);
  const servers = [];
  $(".type").each((_, typeEl) => {
    const $type = $(typeEl);
    const serverType = $type.attr("data-type") ?? type;
    if (type !== "raw" && serverType !== type) return;
    $type.find("li[data-link-id]").each((_2, li) => {
      const $li = $(li);
      const linkId = $li.attr("data-link-id") ?? "";
      const svId = $li.attr("data-sv-id") ?? "";
      const name = $li.text().trim() || svId;
      if (linkId) {
        servers.push({ id: linkId, name, type: serverType });
      }
    });
  });
  cacheSet(cacheKey, servers, 300);
  return servers;
}
async function getEmbedUrl(linkId, refererAnimeId) {
  const resp = await ajaxClient.get("/ajax/sources", {
    params: { id: linkId },
    headers: {
      Referer: refererAnimeId ? `${BASE_URL}/watch/${refererAnimeId}` : BASE_URL
    }
  });
  const data = resp.data;
  if (!data.result?.url) return null;
  return data.result;
}

// src/lib/logger.ts
import pino from "pino";
var logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport: process.env["NODE_ENV"] !== "production" ? { target: "pino-pretty", options: { colorize: true } } : void 0
});

// src/lib/anime/providers/vidplay.ts
import axios2 from "axios";
import * as cheerio2 from "cheerio";
import CryptoJS from "crypto-js";
var FALLBACK_KEYS = [[8, 0], [6, 2], [1, 5]];
async function fetchVidplayKeys() {
  try {
    const resp = await axios2.get(
      "https://raw.githubusercontent.com/consumet/consumet.ts/master/src/extractors/vidplay.ts",
      { timeout: 5e3 }
    );
    const text = resp.data;
    const match = text.match(/const\s+keys\s*=\s*(\[\[.*?\]\])/s);
    if (match) {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    logger.warn("could not fetch live vidplay keys, using fallback");
  }
  return FALLBACK_KEYS;
}
function vrfEncrypt(id, keys) {
  let result = id;
  for (const [key] of keys) {
    const wordArray = CryptoJS.enc.Utf8.parse(result);
    const encrypted = CryptoJS.RC4.encrypt(
      wordArray,
      CryptoJS.enc.Utf8.parse(String(key))
    );
    result = encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  }
  return encodeURIComponent(result.replace(/\//g, "_").replace(/\+/g, "-"));
}
function buildFutoken(keys, id) {
  const parts = [`k=${keys.map((k) => k[0]).join(",")}`];
  for (let i = 0; i < keys.length; i++) {
    const [start, offset] = keys[i];
    const slice = id.slice(start, start + offset) || String(start);
    parts.push(slice);
  }
  return parts.join(",");
}
function aesDecrypt(ciphertext, key) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}
async function extractVidplay(embedUrl) {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  let embedHtml;
  try {
    const resp = await axios2.get(embedUrl, {
      timeout: 15e3,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
        Referer: "https://aniwaves.ru/"
      }
    });
    embedHtml = resp.data;
  } catch (err) {
    logger.error({ error: err.message }, "[Vidplay] Stage 1 FAILED");
    return null;
  }
  const $ = cheerio2.load(embedHtml);
  const scriptContent = $("script:not([src])").map((_, el) => $(el).html() ?? "").get().join("\n");
  let rawId = null;
  const idPatterns = [
    /getSources\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/,
    /var\s+id\s*=\s*['"]([^'"]+)['"]/,
    /["']id["']\s*:\s*["']([^'"]+)["']/,
    /\.getSources\s*\(\s*['"]([^'"]+)['"]/
  ];
  for (const pat of idPatterns) {
    const m = scriptContent.match(pat);
    if (m) {
      rawId = m[1] ?? null;
      break;
    }
  }
  if (!rawId) {
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    rawId = pathParts[pathParts.length - 1] ?? null;
  }
  if (!rawId) {
    logger.error("[Vidplay] no source ID found");
    return null;
  }
  const keys = await fetchVidplayKeys();
  const token = buildFutoken(keys, rawId);
  const encodedId = vrfEncrypt(rawId, keys);
  const mediaInfoUrl = `https://${host}/mediainfo/${encodedId}`;
  let rawBody;
  try {
    const resp = await axios2.get(mediaInfoUrl, {
      params: { t: token },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest"
      },
      timeout: 15e3
    });
    rawBody = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
  } catch (err) {
    logger.error({ error: err.message }, "[Vidplay] Stage 3 FAILED");
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = { encrypted: true, sources: rawBody };
  }
  let sourcesData = parsed["sources"];
  const isEncrypted = parsed["encrypted"] === true || typeof parsed["sources"] === "string";
  if (isEncrypted && typeof sourcesData === "string") {
    const decryptionKeys = [
      "9Y6I6HiQOqjDUlbAEWtFhg==",
      "WXrUARXb1aDLaZjI",
      "4wZuP5YkT1a4wZuP",
      "LXgbdW5rQ3VzdG9t"
    ];
    let decrypted = null;
    for (const dkey of decryptionKeys) {
      try {
        const result = aesDecrypt(sourcesData, dkey);
        if (result && result.startsWith("[")) {
          decrypted = result;
          break;
        }
      } catch {
      }
    }
    if (!decrypted) {
      try {
        const keyBytes = CryptoJS.MD5(rawId).toString();
        const result = aesDecrypt(sourcesData, keyBytes);
        if (result && result.length > 5) decrypted = result;
      } catch {
      }
    }
    if (!decrypted) {
      logger.error("[Vidplay] all decryption attempts failed");
      return null;
    }
    try {
      sourcesData = JSON.parse(decrypted);
    } catch {
      logger.error("[Vidplay] decrypted payload is not valid JSON");
      return null;
    }
  }
  const sourcesArr = Array.isArray(sourcesData) ? sourcesData : Array.isArray(parsed["sources"]) ? parsed["sources"] : [];
  if (sourcesArr.length === 0) {
    logger.error("[Vidplay] empty source array");
    return null;
  }
  const tracksRaw = parsed["tracks"] ?? parsed["subtitles"] ?? [];
  const subtitles = tracksRaw.filter((t) => t.kind !== "thumbnails").map((t) => ({
    lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
    label: t.label ?? "Unknown",
    url: t.file ?? t.src ?? ""
  })).filter((s) => s.url);
  const thumbnailTrack = tracksRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;
  const intro = parsed["intro"] ?? null;
  const outro = parsed["outro"] ?? null;
  const m3u8Source = sourcesArr.find(
    (s) => (s.file ?? s.url ?? s.src ?? "").toLowerCase().includes(".m3u8")
  );
  const anySource = sourcesArr[0];
  const m3u8 = m3u8Source?.file ?? m3u8Source?.url ?? m3u8Source?.src ?? anySource?.file ?? anySource?.url ?? anySource?.src ?? null;
  if (!m3u8) {
    logger.error("[Vidplay] no m3u8 URL found");
    return null;
  }
  return {
    type: "direct",
    provider: "vidplay",
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro
  };
}
function isVidplayHost(embedUrl) {
  try {
    const host = new URL(embedUrl).hostname;
    return host.includes("vidplay") || host.includes("vidcloud") || host.includes("mcloud") || host.includes("goload") || host.includes("vidstreaming");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/byfms.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ANIWAVES_REFERER = "https://aniwaves.ru/";
var ANIWAVES_ORIGIN = "https://aniwaves.ru";
var M3U8_TIMEOUT_MS = 3e4;
var PAGE_LOAD_TIMEOUT_MS = 2e4;
function forceAutoplay(url) {
  return url.replace(/autoPlay=0/gi, "autoPlay=1").replace(/autoplay=0/gi, "autoplay=1");
}
async function extractByfms(embedUrl, skipData) {
  const autoplayUrl = forceAutoplay(embedUrl);
  logger.info(
    { embedUrl: autoplayUrl.slice(0, 90) },
    "[BYFMS] launching headless Chromium"
  );
  let browser = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--no-first-run",
        "--no-zygote",
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
        "--allow-running-insecure-content"
      ]
    });
    const context = await browser.newContext({
      userAgent: UA,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Referer: ANIWAVES_REFERER,
        Origin: ANIWAVES_ORIGIN
      }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();
    const m3u8Urls = [];
    const subtitleUrls = [];
    let thumbnailUrl = null;
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[BYFMS] m3u8 request intercepted");
        if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
      }
      if (url.includes(".vtt") || url.includes(".srt")) {
        const label = (() => {
          try {
            return new URL(url).searchParams.get("label") ?? "unknown";
          } catch {
            return "unknown";
          }
        })();
        subtitleUrls.push({ url, label });
      }
      if ((url.includes("thumbnail") || url.includes("sprite") || url.includes("preview")) && !thumbnailUrl) {
        thumbnailUrl = url;
      }
    });
    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes(".m3u8") && !m3u8Urls.includes(url)) {
        m3u8Urls.push(url);
        return;
      }
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json") && m3u8Urls.length === 0) {
        try {
          const text = await resp.text();
          if (text.includes(".m3u8")) {
            const match = text.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
            if (match && !m3u8Urls.includes(match[0])) {
              m3u8Urls.push(match[0]);
            }
          }
        } catch {
        }
      }
    });
    const waitForM3u8 = (timeoutMs) => new Promise((resolve) => {
      const iv = setInterval(() => {
        if (m3u8Urls.length > 0) {
          clearInterval(iv);
          resolve();
        }
      }, 200);
      setTimeout(() => {
        clearInterval(iv);
        resolve();
      }, timeoutMs);
    });
    logger.info("[BYFMS] navigating to embed page");
    await page.goto(autoplayUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS }).catch((err) => {
      logger.warn({ error: err.message }, "[BYFMS] page.goto error, continuing");
    });
    await waitForM3u8(M3U8_TIMEOUT_MS);
    if (m3u8Urls.length === 0) {
      logger.error("[BYFMS] no m3u8 intercepted");
      return null;
    }
    const m3u8 = m3u8Urls.find((u) => u.includes("master")) ?? m3u8Urls.find((u) => !u.includes("segment") && !u.includes("chunk") && !u.includes(".ts?")) ?? m3u8Urls[0];
    logger.info({ m3u8: m3u8.slice(0, 130) }, "[BYFMS] extraction SUCCESS");
    let intro = null;
    let outro = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    const subtitles = subtitleUrls.map((s, i) => ({
      lang: `track-${i}`,
      label: s.label,
      url: s.url
    }));
    return {
      type: "direct",
      provider: "byfms",
      m3u8,
      subtitles,
      thumbnails: thumbnailUrl,
      intro,
      outro
    };
  } catch (err) {
    logger.error({ error: err.message }, "[BYFMS] fatal error");
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {
      });
    }
  }
}
function isByfmsHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("weneverbeenfree") || host.includes("wnbf") || host.includes("myvidplay") || host.includes("animefever");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/dghg.ts
import axios3 from "axios";
var PLAYMOGO_HOSTS = [
  "playmogo.com",
  "myvidplay.com",
  "doodstream.com",
  "dood.la",
  "dood.to",
  "dood.so",
  "dood.ws",
  "dood.pm",
  "dood.wf",
  "dood.re",
  "dood.yt",
  "dood.cx",
  "dood.sh",
  "dood.watch"
];
async function extractDghg(embedUrl, skipData) {
  logger.info({ embedUrl: embedUrl.slice(0, 80) }, "[DGHG] starting extraction");
  const commonHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
    Referer: "https://aniwaves.ru/"
  };
  let html;
  try {
    const resp = await axios3.get(embedUrl, {
      timeout: 15e3,
      headers: commonHeaders,
      maxRedirects: 5
    });
    html = resp.data;
  } catch (err) {
    logger.error({ error: err.message }, "[DGHG] Step 1 FAILED");
    return null;
  }
  const fileIdMatch = html.match(/file_id['"]\s*,\s*['"]([^'"]+)['"]/);
  const fileId = fileIdMatch?.[1] ?? null;
  const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/) || html.match(/pass_md5\/[^"]+\/([^"'\\/]+)['"]?/) || html.match(/\?token=([a-zA-Z0-9]+)/);
  let token = tokenMatch?.[1] ?? null;
  const passMd5Match = html.match(
    /\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]/
  );
  let passMd5Path = null;
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
    if (!token) {
      const pathParts = passMd5Path.split("/");
      if (pathParts.length >= 2) token = pathParts[1] || null;
    }
  }
  if (!fileId && !passMd5Path) {
    logger.error("[DGHG] Step 2 FAILED \u2014 no file_id or pass_md5 path");
    return null;
  }
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  let cdnBaseUrl = null;
  if (passMd5Path) {
    try {
      const passMd5Url = `https://${host}/pass_md5/${passMd5Path}`;
      const resp = await axios3.get(passMd5Url, {
        timeout: 15e3,
        headers: { ...commonHeaders, Referer: embedUrl },
        maxRedirects: 5
      });
      cdnBaseUrl = resp.data?.trim() || null;
    } catch (err) {
      const e = err;
      if (e.response?.data) cdnBaseUrl = e.response.data?.trim() || null;
    }
  }
  if (!cdnBaseUrl && fileId && token) {
    const randomSuffix = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const passMd5Path2 = `${fileId}-${randomSuffix}/${token}`;
    try {
      const passMd5Url = `https://${host}/pass_md5/${passMd5Path2}`;
      const resp = await axios3.get(passMd5Url, {
        timeout: 15e3,
        headers: { ...commonHeaders, Referer: embedUrl },
        maxRedirects: 0,
        validateStatus: (s) => s === 200 || s === 301 || s === 302
      });
      cdnBaseUrl = resp.data?.trim() || null;
    } catch (err) {
      const e = err;
      if (e.response?.data) cdnBaseUrl = e.response.data?.trim() || null;
    }
  }
  if (!cdnBaseUrl) {
    logger.error("[DGHG] Step 3 FAILED \u2014 no CDN URL");
    return null;
  }
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;
  let intro = null;
  let outro = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }
  logger.info("[DGHG] extraction complete \u2014 SUCCESS");
  return {
    type: "direct",
    provider: "dghg",
    m3u8: finalUrl,
    subtitles: [],
    thumbnails: null,
    intro,
    outro
  };
}
function isDghgHost(url) {
  try {
    const host = new URL(url).hostname;
    return PLAYMOGO_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

// src/lib/anime/providers/index.ts
async function extractStream(embedUrl, serverName, skipData) {
  const lowerName = serverName.toLowerCase();
  logger.info(
    { embedUrl: embedUrl.slice(0, 90), serverName },
    "dispatching to provider extractor"
  );
  if (isDghgHost(embedUrl) || lowerName.includes("dghg") || lowerName.includes("playmogo") || lowerName.includes("dood")) {
    logger.info({ serverName }, "routing to DGHG extractor");
    return extractDghg(embedUrl, skipData);
  }
  if (isByfmsHost(embedUrl) || lowerName.includes("byfms") || lowerName.includes("weneverbeenfree")) {
    logger.info({ serverName }, "routing to BYFMS extractor");
    return extractByfms(embedUrl, skipData);
  }
  if (isVidplayHost(embedUrl) || lowerName.includes("vidplay") || lowerName.includes("vidcloud")) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 90) },
    "unknown provider \u2014 trying all extractors"
  );
  const attempts = [
    () => extractDghg(embedUrl, skipData),
    () => extractVidplay(embedUrl),
    () => extractByfms(embedUrl, skipData)
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result?.m3u8) return result;
    } catch {
    }
  }
  logger.error({ serverName, embedUrl: embedUrl.slice(0, 90) }, "all extractors failed");
  return null;
}

// src/routes/anime.ts
var router2 = Router2();
router2.get("/search", async (req, res) => {
  const q = Array.isArray(req.query["q"]) ? req.query["q"][0] : req.query["q"];
  if (!q || typeof q !== "string") {
    res.status(400).json({ error: "Missing query param: q" });
    return;
  }
  const results = await searchAnime(q);
  res.json({ results });
});
router2.get("/details", async (req, res) => {
  const id = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const details = await getAnimeDetails(id);
  res.json(details);
});
router2.get("/episodes", async (req, res) => {
  const id = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const episodes = await getEpisodes(id);
  res.json({ episodes });
});
router2.get("/servers", async (req, res) => {
  const id = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"]) ? req.query["ep"][0] : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"]) ? req.query["type"][0] : req.query["type"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  if (!epRaw) {
    res.status(400).json({ error: "Missing query param: ep" });
    return;
  }
  const ep = parseInt(String(epRaw), 10);
  if (isNaN(ep)) {
    res.status(400).json({ error: "param ep must be a number" });
    return;
  }
  const type = typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const servers = await getServers(id, ep, type);
  res.json({ servers });
});
router2.get("/stream", async (req, res) => {
  const id = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"]) ? req.query["ep"][0] : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"]) ? req.query["type"][0] : req.query["type"];
  const serverParam = Array.isArray(req.query["server"]) ? req.query["server"][0] : req.query["server"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  if (!epRaw) {
    res.status(400).json({ error: "Missing query param: ep" });
    return;
  }
  const ep = parseInt(String(epRaw), 10);
  if (isNaN(ep)) {
    res.status(400).json({ error: "param ep must be a number" });
    return;
  }
  const type = typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const serverName = typeof serverParam === "string" ? serverParam : null;
  req.log.info({ id, ep, type, server: serverName }, "stream requested");
  const servers = await getServers(id, ep, type);
  if (servers.length === 0) {
    res.status(404).json({ error: "No servers found for this episode/type" });
    return;
  }
  if (serverName) {
    const targetServer = servers.find(
      (s) => s.name.toLowerCase().includes(serverName.toLowerCase())
    );
    if (!targetServer) {
      res.status(404).json({
        error: `Server "${serverName}" not available for this episode`,
        availableServers: servers.map((s) => s.name)
      });
      return;
    }
    const sourcesResult = await getEmbedUrl(targetServer.id, id);
    if (!sourcesResult?.url) {
      res.status(502).json({ error: `Could not resolve embed URL for server "${serverName}"` });
      return;
    }
    const stream = await extractStream(sourcesResult.url, targetServer.name, {
      intro: sourcesResult.skip_data?.intro,
      outro: sourcesResult.skip_data?.outro
    });
    if (stream?.m3u8) {
      res.json({ ...stream, _server: targetServer.name });
      return;
    }
    res.status(502).json({
      error: `Server "${serverName}" failed to extract stream`,
      server: targetServer.name
    });
    return;
  }
  const failedServers = [];
  for (const server of servers) {
    const sourcesResult = await getEmbedUrl(server.id, id);
    if (!sourcesResult?.url) {
      failedServers.push(server.name);
      continue;
    }
    const stream = await extractStream(sourcesResult.url, server.name, {
      intro: sourcesResult.skip_data?.intro,
      outro: sourcesResult.skip_data?.outro
    });
    if (stream?.m3u8) {
      res.json({ ...stream, _server: server.name, _failedServers: failedServers });
      return;
    }
    failedServers.push(server.name);
  }
  res.status(502).json({
    error: "All servers failed",
    failedServers
  });
});
router2.get("/proxy", async (req, res) => {
  const urlParam = Array.isArray(req.query["url"]) ? req.query["url"][0] : req.query["url"];
  const refererParam = Array.isArray(req.query["referer"]) ? req.query["referer"][0] : req.query["referer"];
  if (!urlParam || typeof urlParam !== "string") {
    res.status(400).json({ error: "Missing query param: url" });
    return;
  }
  let targetUrl;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }
  let referer = typeof refererParam === "string" ? refererParam : null;
  if (!referer) {
    referer = `https://${targetUrl.hostname}/`;
  }
  try {
    const upstream = await axios4.get(urlParam, {
      responseType: "stream",
      timeout: 3e4,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: "*/*",
        "Accept-Encoding": "identity"
      },
      maxRedirects: 5
    });
    const contentType = upstream.headers["content-type"];
    const contentLength = upstream.headers["content-length"];
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    if (contentType?.includes("mpegurl") || urlParam.includes(".m3u8")) {
      const chunks = [];
      upstream.data.on("data", (chunk) => chunks.push(chunk));
      upstream.data.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const encodedReferer = encodeURIComponent(referer ?? "");
        const baseUrl = urlParam.substring(0, urlParam.lastIndexOf("/") + 1);
        const rewritten = body.split("\n").map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
              const abs2 = uri.startsWith("http") ? uri : baseUrl + uri;
              return `URI="/api/proxy?url=${encodeURIComponent(abs2)}&referer=${encodedReferer}"`;
            });
          }
          if (trimmed.startsWith("#")) return line;
          const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
          return `/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
        }).join("\n");
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
    const e = err;
    if (!res.headersSent) {
      res.status(502).json({
        error: "Proxy failed",
        reason: e.message,
        upstreamStatus: e.response?.status ?? null
      });
    }
  }
});
var anime_default = router2;

// src/routes/index.ts
var router3 = Router3();
router3.use(health_default);
router3.use(anime_default);
var routes_default = router3;

// src/app.ts
var app = express();
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      }
    }
  })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", routes_default);
var app_default = app;

// src/index.ts
var rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
var port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}
app_default.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Aniwaves API server listening");
});
//# sourceMappingURL=index.mjs.map
