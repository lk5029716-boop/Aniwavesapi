// src/app.ts
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";

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
import axios7 from "axios";

// src/lib/anime/scraper.ts
import axios from "axios";
import * as cheerio from "cheerio";

// src/lib/logger.ts
import pino from "pino";
var isProduction = process.env.NODE_ENV === "production";
var logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']"
  ],
  ...isProduction ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    }
  }
});

// src/lib/anime/cache.ts
import NodeCache from "node-cache";
var cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
function cacheGet(key) {
  return cache.get(key);
}
function cacheSet(key, value, ttl = 300) {
  cache.set(key, value, ttl);
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
  if (cached) {
    logger.debug({ q }, "search cache hit");
    return cached;
  }
  logger.info({ q }, "searching anime via /ajax/anime/search");
  const resp = await ajaxClient.get("/ajax/anime/search", {
    params: { keyword: q }
  });
  const data = resp.data;
  const html = typeof data.result === "string" ? data.result : data.result?.html ?? "";
  if (!html) {
    logger.warn({ q, status: data.status }, "search returned no HTML");
    return [];
  }
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
  logger.info({ q, count: results.length }, "search complete");
  return results;
}
async function getNumericId(animeId) {
  const cacheKey = `numericId:${animeId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const resp = await client.get(`/watch/${animeId}`);
  const $ = cheerio.load(resp.data);
  const numericId = $("[data-id]").first().attr("data-id") ?? null;
  if (numericId) {
    cacheSet(cacheKey, numericId, 86400);
  }
  return numericId;
}
async function getAnimeDetails(id) {
  const cacheKey = `details:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.debug({ id }, "details cache hit");
    return cached;
  }
  logger.info({ id }, "fetching anime details from /watch/:id");
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
  if (!totalCount) {
    const jsonLdText = $('script[type="application/ld+json"]').text();
    if (jsonLdText) {
      try {
        const jsonLd = JSON.parse(jsonLdText);
        const graph = jsonLd["@graph"] ?? [];
        for (const node of graph) {
          if (node.numberOfEpisodes) totalCount = node.numberOfEpisodes;
        }
        if (!totalCount && jsonLd.numberOfEpisodes) totalCount = jsonLd.numberOfEpisodes;
      } catch {
      }
    }
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
  logger.info({ id, title }, "details fetched");
  return details;
}
async function getEpisodes(animeId) {
  const cacheKey = `episodes:${animeId}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.debug({ animeId }, "episodes cache hit");
    return cached;
  }
  logger.info({ animeId }, "fetching episode list");
  const numericId = await getNumericId(animeId);
  if (!numericId) {
    logger.warn({ animeId }, "could not resolve numeric ID");
    return [];
  }
  const resp = await ajaxClient.get(`/ajax/episode/list/${numericId}`, {
    headers: { Referer: `${BASE_URL}/watch/${animeId}` }
  });
  const data = resp.data;
  const html = data.result ?? "";
  if (!html) {
    logger.warn({ animeId, numericId, status: data.status }, "episode list returned no html");
    return [];
  }
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
  logger.info({ animeId, count: episodes.length }, "episodes fetched");
  return episodes;
}
async function getServers(animeId, ep, type) {
  const cacheKey = `servers:${animeId}:${ep}:${type}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.debug({ animeId, ep, type }, "servers cache hit");
    return cached;
  }
  logger.info({ animeId, ep, type }, "fetching server list");
  const episodes = await getEpisodes(animeId);
  const episode = episodes.find((e) => e.number === ep);
  if (!episode) {
    logger.warn({ animeId, ep }, "episode not found");
    return [];
  }
  const [animeNumId, epsNum] = episode.id.split("&eps=");
  const resp = await ajaxClient.get("/ajax/server/list", {
    params: { servers: animeNumId, eps: epsNum },
    headers: { Referer: `${BASE_URL}/watch/${animeId}` }
  });
  const data = resp.data;
  const html = data.result ?? "";
  if (!html) {
    logger.warn({ episodeId: episode.id, type }, "server list returned no html");
    return [];
  }
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
  logger.info({ animeId, ep, type, count: servers.length }, "servers fetched");
  return servers;
}
async function getEmbedUrl(linkId, refererAnimeId) {
  logger.info({ linkId: linkId.slice(0, 40) }, "resolving embed URL from /ajax/sources");
  const resp = await ajaxClient.get("/ajax/sources", {
    params: { id: linkId },
    headers: {
      Referer: refererAnimeId ? `${BASE_URL}/watch/${refererAnimeId}` : BASE_URL
    }
  });
  const data = resp.data;
  logger.debug(
    {
      status: data.status,
      url: data.result?.url?.slice(0, 80),
      sourcesCount: data.result?.sources?.length ?? 0
    },
    "sources endpoint response"
  );
  if (!data.result?.url) {
    logger.warn({ linkId: linkId.slice(0, 40) }, "no URL in sources result");
    return null;
  }
  return data.result;
}

// src/lib/anime/providers/vidplay.ts
import axios2 from "axios";
import * as cheerio2 from "cheerio";
import CryptoJS from "crypto-js";
var VIDPLAY_HOSTS = [
  "vidplay.online",
  "vidplay.lol",
  "vidcloud.lol",
  "mcloud.bz"
];
var MEGACLOUD_HOSTS = ["megacloud.tv", "rapid-cloud.co", "rabbitstream.net"];
var FALLBACK_KEYS = [
  [8, 0],
  [6, 2],
  [1, 5]
];
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
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.debug({ count: parsed.length }, "vidplay keys fetched from repo");
        return parsed;
      }
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
    const encrypted = CryptoJS.RC4.encrypt(wordArray, CryptoJS.enc.Utf8.parse(String(key)));
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
  logger.info({ embedUrl, host }, "[Stage 1] fetching embed page");
  let embedHtml;
  try {
    const resp = await axios2.get(embedUrl, {
      timeout: 15e3,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
        Referer: "https://aniwaves.ru/"
      }
    });
    embedHtml = resp.data;
    logger.debug(
      { status: resp.status, snippet: embedHtml.slice(0, 300) },
      "[Stage 1] embed page fetched"
    );
  } catch (err) {
    const e = err;
    logger.error({ embedUrl, error: e.message }, "[Stage 1] embed page fetch failed");
    return null;
  }
  const $ = cheerio2.load(embedHtml);
  let rawId = null;
  let sourcesPath = null;
  const scriptContent = $("script:not([src])").map((_, el) => $(el).html() ?? "").get().join("\n");
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
  const pathPatterns = [
    /getSources\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/,
    /sourcesUrl\s*=\s*['"]([^'"]+)['"]/,
    /["']sources["']\s*:\s*["']([^'"]+)["']/
  ];
  for (const pat of pathPatterns) {
    const m = scriptContent.match(pat);
    if (m) {
      sourcesPath = m[1] ?? null;
      break;
    }
  }
  if (!rawId) {
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    rawId = pathParts[pathParts.length - 1] ?? null;
  }
  logger.debug({ rawId, sourcesPath }, "[Stage 1] extracted embed metadata");
  if (!rawId) {
    logger.error({ embedUrl }, "[Stage 1] FAILED \u2014 could not extract source ID from embed page");
    return null;
  }
  logger.info({ host }, "[Stage 2] fetching futoken keys");
  const keys = await fetchVidplayKeys();
  const token = buildFutoken(keys, rawId);
  const encodedId = vrfEncrypt(rawId, keys);
  logger.debug(
    { token: token.slice(0, 60), encodedId: encodedId.slice(0, 40) },
    "[Stage 2] token generated"
  );
  const mediaInfoUrl = sourcesPath ? `https://${host}${sourcesPath}` : `https://${host}/mediainfo/${encodedId}`;
  const mediaInfoParams = { t: token };
  if (urlObj.searchParams.get("t")) {
    mediaInfoParams["autoplay"] = "1";
  }
  logger.info(
    { mediaInfoUrl, params: mediaInfoParams },
    "[Stage 3] requesting source API"
  );
  let rawBody;
  try {
    const resp = await axios2.get(mediaInfoUrl, {
      params: mediaInfoParams,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest"
      },
      timeout: 15e3
    });
    rawBody = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    logger.debug(
      { status: resp.status, snippet: rawBody.slice(0, 300) },
      "[Stage 3] source API response"
    );
  } catch (err) {
    const e = err;
    logger.error(
      {
        mediaInfoUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200)
      },
      "[Stage 3] FAILED \u2014 source API request failed"
    );
    return null;
  }
  logger.info("[Stage 4] parsing source API response");
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logger.warn({ snippet: rawBody.slice(0, 100) }, "[Stage 4] response is not JSON, may be encrypted");
    parsed = { encrypted: true, sources: rawBody };
  }
  logger.debug(
    { keys: Object.keys(parsed), encrypted: parsed["encrypted"] },
    "[Stage 4] raw response structure"
  );
  logger.info("[Stage 5] decryption stage");
  let sourcesData = parsed["sources"];
  const isEncrypted = parsed["encrypted"] === true || typeof parsed["sources"] === "string";
  if (isEncrypted && typeof sourcesData === "string") {
    logger.debug({ encrypted: true }, "[Stage 5] sources appear AES-encrypted");
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
          logger.debug({ key: dkey }, "[Stage 5] AES decryption succeeded");
          break;
        }
      } catch {
      }
    }
    if (!decrypted) {
      try {
        const keyBytes = CryptoJS.MD5(rawId).toString();
        const result = aesDecrypt(sourcesData, keyBytes);
        if (result && result.length > 5) {
          decrypted = result;
          logger.debug({ key: "MD5(rawId)" }, "[Stage 5] AES decryption succeeded with MD5 key");
        }
      } catch {
      }
    }
    if (!decrypted) {
      logger.error("[Stage 5] FAILED \u2014 all decryption attempts failed for encrypted sources");
      return null;
    }
    try {
      sourcesData = JSON.parse(decrypted);
    } catch {
      logger.error({ snippet: decrypted.slice(0, 100) }, "[Stage 5] FAILED \u2014 decrypted payload is not valid JSON");
      return null;
    }
  } else {
    logger.debug("[Stage 5] sources not encrypted, skipping decryption");
  }
  logger.info("[Stage 6] parsing source list");
  const sourcesArr = Array.isArray(sourcesData) ? sourcesData : Array.isArray(parsed["sources"]) ? parsed["sources"] : [];
  logger.debug(
    { count: sourcesArr.length, first: JSON.stringify(sourcesArr[0] ?? {}).slice(0, 150) },
    "[Stage 6] source array"
  );
  if (sourcesArr.length === 0) {
    logger.error("[Stage 6] FAILED \u2014 source array is empty after parsing");
    return null;
  }
  const subtitlesRaw = parsed["tracks"] ?? parsed["subtitles"] ?? [];
  const subtitles = subtitlesRaw.filter((t) => t.kind !== "thumbnails").map((t) => ({
    lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
    label: t.label ?? "Unknown",
    url: t.file ?? t.src ?? ""
  })).filter((s) => s.url);
  const thumbnailTrack = subtitlesRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack ? thumbnailTrack.file ?? thumbnailTrack.src ?? null : null;
  const intro = parsed["intro"] ?? null;
  const outro = parsed["outro"] ?? null;
  logger.info("[Stage 7] selecting final m3u8");
  const m3u8Source = sourcesArr.find(
    (s) => (s.file ?? s.url ?? s.src ?? "").toLowerCase().includes(".m3u8")
  );
  const anySource = sourcesArr[0];
  const m3u8 = m3u8Source?.file ?? m3u8Source?.url ?? m3u8Source?.src ?? anySource?.file ?? anySource?.url ?? anySource?.src ?? null;
  logger.info(
    { m3u8: m3u8?.slice(0, 80) ?? null, provider: "vidplay", subtitleCount: subtitles.length },
    "[Stage 7] extraction complete"
  );
  if (!m3u8) {
    logger.error("[Stage 7] FAILED \u2014 no m3u8 URL found in source array");
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
    return VIDPLAY_HOSTS.some((h) => host.includes(h)) || MEGACLOUD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

// src/lib/anime/providers/megacloud.ts
import axios3 from "axios";
import * as cheerio3 from "cheerio";
import CryptoJS2 from "crypto-js";
var MEGACLOUD_KEYS_URL = "https://raw.githubusercontent.com/theonlymo/keys/main/key";
async function fetchMegacloudKey() {
  try {
    const resp = await axios3.get(MEGACLOUD_KEYS_URL, { timeout: 5e3 });
    const key = typeof resp.data === "string" ? resp.data.trim() : JSON.stringify(resp.data);
    logger.debug({ key: key.slice(0, 20) }, "megacloud key fetched");
    return key;
  } catch {
    logger.warn("could not fetch megacloud key");
    return null;
  }
}
function extractKeyAndDecrypt(ciphertext, keyFromScript) {
  try {
    const decrypted = CryptoJS2.AES.decrypt(ciphertext, keyFromScript).toString(
      CryptoJS2.enc.Utf8
    );
    if (decrypted && (decrypted.startsWith("[") || decrypted.startsWith("{"))) {
      return decrypted;
    }
  } catch {
  }
  return null;
}
function extractKeyFromScript(scriptContent) {
  const patterns = [
    /(?:var|let|const)\s+key\s*=\s*['"]([^'"]{8,})['"]/,
    /key\s*:\s*['"]([^'"]{8,})['"]/,
    /decryptionKey\s*[:=]\s*['"]([^'"]{8,})['"]/,
    /k\s*=\s*['"]([^'"]{8,})['"]/
  ];
  for (const p of patterns) {
    const m = scriptContent.match(p);
    if (m) return m[1] ?? null;
  }
  return null;
}
async function extractMegacloud(embedUrl) {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const sourceId = pathParts[pathParts.length - 1];
  if (!sourceId) {
    logger.error({ embedUrl }, "[MegaCloud Stage 1] FAILED \u2014 no sourceId in URL");
    return null;
  }
  logger.info({ embedUrl, host, sourceId }, "[MegaCloud Stage 1] fetching embed page");
  let embedHtml = "";
  let scriptKey = null;
  try {
    const resp = await axios3.get(embedUrl, {
      timeout: 15e3,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://aniwaves.ru/"
      }
    });
    embedHtml = resp.data;
    logger.debug(
      { status: resp.status, snippet: embedHtml.slice(0, 200) },
      "[MegaCloud Stage 1] embed page fetched"
    );
    const $ = cheerio3.load(embedHtml);
    const scripts = $("script:not([src])").map((_, el) => $(el).html() ?? "").get().join("\n");
    scriptKey = extractKeyFromScript(scripts);
    if (scriptKey) {
      logger.debug({ scriptKey: scriptKey.slice(0, 20) }, "[MegaCloud Stage 1] key found in page scripts");
    }
  } catch (err) {
    const e = err;
    logger.warn({ error: e.message }, "[MegaCloud Stage 1] embed page fetch failed, continuing");
  }
  const endpointMap = {
    "megacloud.tv": "/embed-2/ajax/e-1/getSources",
    "rapid-cloud.co": "/embed-6/ajax/e-1/getSources",
    "rabbitstream.net": "/embed-4/ajax/e-1/getSources"
  };
  let sourcesPath = "/embed-2/ajax/e-1/getSources";
  for (const [h, p] of Object.entries(endpointMap)) {
    if (host.includes(h)) {
      sourcesPath = p;
      break;
    }
  }
  const sourcesUrl = `https://${host}${sourcesPath}`;
  logger.info(
    { sourcesUrl, sourceId },
    "[MegaCloud Stage 2] requesting sources"
  );
  let data;
  try {
    const resp = await axios3.get(sourcesUrl, {
      params: { id: sourceId },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest"
      },
      timeout: 15e3
    });
    data = resp.data;
    logger.debug(
      { status: resp.status, snippet: JSON.stringify(data).slice(0, 300) },
      "[MegaCloud Stage 2] sources response"
    );
  } catch (err) {
    const e = err;
    logger.error(
      {
        sourcesUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200)
      },
      "[MegaCloud Stage 2] FAILED \u2014 sources request failed"
    );
    return null;
  }
  logger.info("[MegaCloud Stage 3] decryption check");
  let sourcesArr = [];
  const isEncrypted = data["encrypted"] === true || typeof data["sources"] === "string";
  if (isEncrypted && typeof data["sources"] === "string") {
    logger.debug("[MegaCloud Stage 3] sources encrypted, attempting decryption");
    const remoteKey = await fetchMegacloudKey();
    const keysToTry = [
      scriptKey,
      remoteKey,
      "c1d17096f2ca11b7",
      "9Y6I6HiQOqjDUlbA",
      "koko"
    ].filter(Boolean);
    let decrypted = null;
    for (const k of keysToTry) {
      decrypted = extractKeyAndDecrypt(data["sources"], k);
      if (decrypted) {
        logger.debug({ key: k.slice(0, 15) }, "[MegaCloud Stage 3] decryption succeeded");
        break;
      }
    }
    if (!decrypted) {
      logger.error("[MegaCloud Stage 3] FAILED \u2014 all decryption attempts failed");
      return null;
    }
    try {
      sourcesArr = JSON.parse(decrypted);
    } catch {
      logger.error("[MegaCloud Stage 3] FAILED \u2014 decrypted payload is not valid JSON");
      return null;
    }
  } else {
    sourcesArr = Array.isArray(data["sources"]) ? data["sources"] : [];
    logger.debug("[MegaCloud Stage 3] sources not encrypted");
  }
  logger.info(
    { count: sourcesArr.length },
    "[MegaCloud Stage 4] source list parsed"
  );
  if (sourcesArr.length === 0) {
    logger.error("[MegaCloud Stage 4] FAILED \u2014 empty source array");
    return null;
  }
  const tracksRaw = data["tracks"] ?? [];
  const subtitles = tracksRaw.filter((t) => t.kind !== "thumbnails").map((t) => ({
    lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
    label: t.label ?? "Unknown",
    url: t.file ?? t.src ?? ""
  })).filter((s) => s.url);
  const thumbnailTrack = tracksRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;
  const intro = data["intro"] ?? null;
  const outro = data["outro"] ?? null;
  const best = sourcesArr.find(
    (s) => (s.file ?? s.url ?? s.src ?? "").includes(".m3u8")
  ) ?? sourcesArr[0];
  const m3u8 = best?.file ?? best?.url ?? best?.src ?? null;
  logger.info(
    { m3u8: m3u8?.slice(0, 80) ?? null, provider: "megacloud" },
    "[MegaCloud Stage 5] extraction complete"
  );
  if (!m3u8) {
    logger.error("[MegaCloud Stage 5] FAILED \u2014 no m3u8 URL in source array");
    return null;
  }
  return {
    type: "direct",
    provider: "megacloud",
    m3u8,
    subtitles,
    thumbnails: thumbnails ?? null,
    intro,
    outro
  };
}
function isMegacloudHost(embedUrl) {
  try {
    const host = new URL(embedUrl).hostname;
    return host.includes("megacloud") || host.includes("rapid-cloud") || host.includes("rabbitstream");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/echovideo.ts
import axios4 from "axios";

// src/lib/anime/providers/playwright-extractor.ts
import https from "https";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ANIWAVES_REFERER = "https://aniwaves.ru/";
var ANIWAVES_ORIGIN = "https://aniwaves.ru";
var M3U8_TIMEOUT_MS = 3e4;
var PAGE_LOAD_TIMEOUT_MS = 2e4;
function forceAutoplay(url) {
  return url.replace(/autoPlay=0/gi, "autoPlay=1").replace(/autoplay=0/gi, "autoplay=1");
}
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(body);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { ...headers, "Content-Length": buf.byteLength }
    };
    const req = https.request(opts, (res) => {
      const respHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v) respHeaders[k] = Array.isArray(v) ? v[0] : v;
      }
      let data = "";
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: respHeaders }));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}
async function extractViaPlaywright(embedUrl, providerName, skipData) {
  const autoplayUrl = forceAutoplay(embedUrl);
  logger.info(
    { embedUrl: autoplayUrl.slice(0, 90), providerName },
    "[Playwright] launching headless Chromium (Byse CDN extractor)"
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
      permissions: ["camera", "microphone"],
      // Set Referer to aniwaves.ru at context level.
      // This makes the /embed/details call pass the domain whitelist check.
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
    await page.route("**/embed/playback**", async (route) => {
      const reqBody = route.request().postData() ?? "{}";
      const reqUrl = route.request().url();
      logger.info(
        { url: reqUrl.slice(0, 90) },
        "[Playwright] intercepting /embed/playback \u2014 re-issuing with aniwaves.ru Origin"
      );
      try {
        const resp = await httpsPost(reqUrl, {
          "User-Agent": UA,
          "Referer": ANIWAVES_REFERER,
          "Origin": ANIWAVES_ORIGIN,
          "Content-Type": "application/json",
          "Accept": "application/json"
        }, reqBody);
        logger.info(
          { status: resp.status, url: reqUrl.slice(0, 90) },
          "[Playwright] /embed/playback direct HTTP response"
        );
        await route.fulfill({
          status: resp.status,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true"
          },
          body: resp.body
        });
      } catch (err) {
        logger.warn(
          { error: err.message },
          "[Playwright] failed to re-issue /embed/playback \u2014 falling back to continue"
        );
        await route.continue();
      }
    });
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(".m3u8")) {
        logger.info({ url: url.slice(0, 130) }, "[Playwright] \u2713 m3u8 request intercepted");
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
        logger.info({ url: url.slice(0, 130) }, "[Playwright] \u2713 m3u8 response intercepted");
        m3u8Urls.push(url);
        return;
      }
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json") && m3u8Urls.length === 0) {
        try {
          const text = await resp.text();
          if (text.includes(".m3u8")) {
            const match = text.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
            if (match) {
              logger.info({ url: match[0].slice(0, 130) }, "[Playwright] \u2713 m3u8 found in JSON response");
              if (!m3u8Urls.includes(match[0])) m3u8Urls.push(match[0]);
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
    logger.info("[Playwright] navigating to embed page");
    await page.goto(autoplayUrl, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS }).catch((err) => {
      logger.warn({ error: err.message }, "[Playwright] page.goto errored \u2014 continuing");
    });
    await waitForM3u8(M3U8_TIMEOUT_MS);
    if (m3u8Urls.length === 0) {
      const pageTitle = await page.title().catch(() => "unknown");
      const pageUrl = page.url();
      logger.error(
        { embedUrl: autoplayUrl.slice(0, 90), pageTitle, pageUrl },
        "[Playwright] no m3u8 intercepted \u2014 page may be blocked or video not found"
      );
      return null;
    }
    const m3u8 = m3u8Urls.find((u) => u.includes("master")) ?? m3u8Urls.find((u) => !u.includes("segment") && !u.includes("chunk") && !u.includes(".ts?")) ?? m3u8Urls[0];
    logger.info(
      { m3u8: m3u8.slice(0, 130), candidates: m3u8Urls.length },
      "[Playwright] \u2713 extraction SUCCESS"
    );
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
      provider: providerName,
      m3u8,
      subtitles,
      thumbnails: thumbnailUrl,
      intro,
      outro
    };
  } catch (err) {
    logger.error(
      { error: err.message, embedUrl: embedUrl.slice(0, 90) },
      "[Playwright] fatal error"
    );
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {
      });
      logger.debug("[Playwright] browser closed");
    }
  }
}

// src/lib/anime/providers/echovideo.ts
async function extractEchovideo(embedUrl, skipData) {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const pathMatch = urlObj.pathname.match(/^\/(embed-\d+)\//);
  const embedPrefix = pathMatch?.[1] ?? "embed-1";
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const sourceId = pathParts[pathParts.length - 1];
  if (!sourceId) {
    logger.error({ embedUrl }, "[Echovideo S1] FAILED \u2014 no sourceId in URL path");
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }
  logger.info(
    { embedUrl: embedUrl.slice(0, 80), host, embedPrefix, sourceId: sourceId.slice(0, 30) },
    "[Echovideo S1] fetching embed page"
  );
  const commonHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://aniwaves.ru/",
    Accept: "text/html,application/xhtml+xml,*/*"
  };
  try {
    const pageResp = await axios4.get(embedUrl, { timeout: 1e4, headers: commonHeaders });
    logger.debug(
      { status: pageResp.status, snippet: String(pageResp.data).slice(0, 120) },
      "[Echovideo S1] embed page fetched"
    );
  } catch (err) {
    logger.warn({ error: err.message }, "[Echovideo S1] embed page fetch failed, continuing");
  }
  const sourcesUrl = `https://${host}/${embedPrefix}/getSources`;
  logger.info(
    { sourcesUrl, sourceId: sourceId.slice(0, 30) },
    "[Echovideo S2] requesting getSources"
  );
  let data;
  try {
    const resp = await axios4.get(sourcesUrl, {
      params: { id: sourceId },
      headers: {
        "User-Agent": commonHeaders["User-Agent"],
        Accept: "application/json, */*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Site": "same-origin"
      },
      timeout: 12e3
    });
    data = resp.data;
    logger.debug(
      {
        status: resp.status,
        sourcesType: typeof data.sources,
        hasIntro: data.intro != null,
        hasOutro: data.outro != null,
        trackCount: data.tracks?.length ?? 0,
        snippet: JSON.stringify(data).slice(0, 300)
      },
      "[Echovideo S2] getSources response"
    );
  } catch (err) {
    const e = err;
    logger.error(
      {
        sourcesUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200)
      },
      "[Echovideo S2] FAILED \u2014 getSources request failed, falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }
  logger.info("[Echovideo S3] extracting m3u8 URL from response");
  let m3u8 = null;
  if (typeof data.sources === "string" && data.sources.length > 0) {
    m3u8 = data.sources;
    logger.debug({ m3u8: m3u8.slice(0, 80) }, "[Echovideo S3] sources is a plain string URL");
  } else if (Array.isArray(data.sources)) {
    const m3u8Entry = data.sources.find(
      (s) => (s.file ?? s.url ?? "").toLowerCase().includes(".m3u8")
    ) ?? data.sources[0];
    m3u8 = m3u8Entry?.file ?? m3u8Entry?.url ?? null;
    logger.debug({ m3u8: m3u8?.slice(0, 80) ?? null }, "[Echovideo S3] sources is an array");
  }
  if (!m3u8) {
    logger.warn(
      { sourcesRaw: JSON.stringify(data.sources).slice(0, 200) },
      "[Echovideo S3] no m3u8 in sources \u2014 falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }
  logger.info("[Echovideo S4] parsing tracks");
  const tracksRaw = data.tracks ?? [];
  const subtitles = tracksRaw.filter(
    (t) => t.kind !== "thumbnails" && t.kind !== "preview" && (t.file ?? t.src ?? "").length > 0
  ).map((t) => ({
    lang: (t.label ?? "unknown").toLowerCase().replace(/\s+/g, "-"),
    label: t.label ?? "Unknown",
    url: t.file ?? t.src ?? ""
  }));
  const thumbnailTrack = tracksRaw.find(
    (t) => t.kind === "thumbnails" || t.kind === "preview"
  );
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;
  logger.info("[Echovideo S5] building skip times");
  let intro = null;
  let outro = null;
  if (data.intro && (data.intro.start !== 0 || data.intro.end !== 0)) {
    intro = { start: data.intro.start, end: data.intro.end };
  } else if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (data.outro && (data.outro.start !== 0 || data.outro.end !== 0)) {
    outro = { start: data.outro.start, end: data.outro.end };
  } else if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }
  logger.info(
    {
      m3u8: m3u8.slice(0, 100),
      subtitles: subtitles.length,
      thumbnails: thumbnails?.slice(0, 60) ?? null,
      intro,
      outro
    },
    "[Echovideo S5] extraction complete \u2014 SUCCESS"
  );
  return {
    type: "direct",
    provider: "echovideo",
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro
  };
}
function isEchovideoHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("echovideo") || host.includes("echo");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/weneverbeenfree.ts
import axios5 from "axios";
async function tryDecryptAesGcm(ivBase64, cipherBase64, keyHex) {
  try {
    const { webcrypto } = await import("node:crypto");
    const subtle = webcrypto.subtle;
    const keyBytes = Buffer.from(keyHex, "hex");
    const iv = Buffer.from(ivBase64, "base64");
    const ciphertext = Buffer.from(cipherBase64, "base64");
    const cryptoKey = await subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
var KNOWN_KEYS_HEX = [];
async function extractWeneverbeenfree(embedUrl, skipData) {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const videoId = urlObj.pathname.split("/").filter(Boolean).pop();
  if (!videoId) {
    logger.error({ embedUrl }, "[WNBF S1] FAILED \u2014 no videoId in embed URL");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  logger.info(
    { embedUrl: embedUrl.slice(0, 80), host, videoId },
    "[WNBF S1] starting weneverbeenfree extraction"
  );
  const commonHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, */*",
    Origin: `https://${host}`,
    Referer: `https://${host}/e/${videoId}`
  };
  logger.info({ videoId }, "[WNBF S2] fetching embed page for CF cookies");
  let cfCookies = "";
  try {
    const pageResp = await axios5.get(embedUrl, {
      timeout: 12e3,
      headers: {
        ...commonHeaders,
        Accept: "text/html,*/*",
        Referer: "https://aniwaves.ru/"
      },
      withCredentials: true
    });
    const setCookie = pageResp.headers["set-cookie"];
    if (Array.isArray(setCookie)) {
      cfCookies = setCookie.map((c) => c.split(";")[0]).join("; ");
    }
    logger.debug(
      { status: pageResp.status, cookieCount: (setCookie ?? []).length },
      "[WNBF S2] embed page fetched"
    );
  } catch (err) {
    logger.warn({ error: err.message }, "[WNBF S2] embed page fetch failed");
  }
  logger.info({ videoId }, "[WNBF S3] posting heartbeat to get encrypted payload");
  const heartbeatUrl = `https://${host}/api/videos/${videoId}/embed/heartbeat`;
  let heartbeatData = null;
  try {
    const resp = await axios5.post(
      heartbeatUrl,
      { fileId: videoId },
      {
        timeout: 12e3,
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          ...cfCookies ? { Cookie: cfCookies } : {}
        }
      }
    );
    heartbeatData = resp.data;
    logger.debug(
      {
        status: resp.status,
        hasIv: !!heartbeatData?.iv,
        hasPayload: !!heartbeatData?.payload,
        hasSources: !!heartbeatData?.sources,
        error: heartbeatData?.error
      },
      "[WNBF S3] heartbeat response"
    );
  } catch (err) {
    const e = err;
    logger.warn(
      {
        heartbeatUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200)
      },
      "[WNBF S3] heartbeat request failed \u2014 falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  if (heartbeatData?.error) {
    logger.warn(
      { error: heartbeatData.error },
      "[WNBF S3] heartbeat returned error \u2014 falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  if (heartbeatData?.sources) {
    logger.info("[WNBF S3] heartbeat returned unencrypted sources \u2014 skipping decrypt");
    const rawSrc2 = heartbeatData.sources;
    const m3u82 = typeof rawSrc2 === "string" ? rawSrc2 : rawSrc2[0]?.file ?? rawSrc2[0]?.url ?? null;
    return buildResult("weneverbeenfree", m3u82, heartbeatData, skipData);
  }
  const { iv, payload } = heartbeatData ?? {};
  if (!iv || !payload) {
    logger.warn("[WNBF S4] no iv/payload in heartbeat \u2014 falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  logger.info("[WNBF S4] attempting AES-GCM decryption with known keys");
  let decryptedText = null;
  for (const keyHex of KNOWN_KEYS_HEX) {
    decryptedText = await tryDecryptAesGcm(iv, payload, keyHex);
    if (decryptedText) {
      logger.debug(
        { keyHex: keyHex.slice(0, 8) + "..." },
        "[WNBF S4] AES-GCM decryption succeeded"
      );
      break;
    }
  }
  if (!decryptedText) {
    logger.warn("[WNBF S4] all known keys failed \u2014 falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  logger.info("[WNBF S5] parsing decrypted payload");
  let parsed;
  try {
    parsed = JSON.parse(decryptedText);
  } catch {
    logger.error(
      { snippet: decryptedText.slice(0, 100) },
      "[WNBF S5] decrypted payload is not valid JSON \u2014 falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  const rawSrc = parsed.sources;
  const m3u8 = typeof rawSrc === "string" ? rawSrc : rawSrc?.[0]?.file ?? rawSrc?.[0]?.url ?? null;
  if (!m3u8) {
    logger.warn("[WNBF S5] no m3u8 in decrypted payload \u2014 falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }
  return buildResult("weneverbeenfree", m3u8, parsed, skipData);
}
function buildResult(provider, m3u8, data, skipData) {
  const tracksRaw = data.tracks ?? [];
  const subtitles = tracksRaw.filter(
    (t) => t.kind !== "thumbnails" && t.kind !== "preview" && (t.file ?? "").length > 0
  ).map((t) => ({
    lang: (t.label ?? "unknown").toLowerCase().replace(/\s+/g, "-"),
    label: t.label ?? "Unknown",
    url: t.file ?? ""
  }));
  const thumbnailTrack = tracksRaw.find(
    (t) => t.kind === "thumbnails" || t.kind === "preview"
  );
  const thumbnails = thumbnailTrack?.file ?? null;
  let intro = null;
  let outro = null;
  if (data.intro && (data.intro.start !== 0 || data.intro.end !== 0)) {
    intro = { start: data.intro.start, end: data.intro.end };
  } else if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (data.outro && (data.outro.start !== 0 || data.outro.end !== 0)) {
    outro = { start: data.outro.start, end: data.outro.end };
  } else if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }
  logger.info(
    { m3u8: (m3u8 ?? "null").slice(0, 80), subtitles: subtitles.length, intro, outro },
    "[WNBF S7] extraction complete"
  );
  return {
    type: "direct",
    provider,
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro
  };
}
function isWeneverbeenfreeHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("weneverbeenfree") || host.includes("wnbf");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/dghg.ts
import { execSync, execFileSync } from "child_process";
import axios6 from "axios";
var DOOD_HOSTS = [
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
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var curlAvailable = null;
function isCurlAvailable() {
  if (curlAvailable !== null) return curlAvailable;
  try {
    execSync("which curl", { encoding: "utf8", timeout: 5e3 });
    curlAvailable = true;
    logger.info("curl is available");
  } catch {
    curlAvailable = false;
    logger.warn("curl NOT available, will use axios (may get 403 from Cloudflare)");
  }
  return curlAvailable;
}
function isPlaymogoHost(url) {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}
function curlFetch(url, referer) {
  try {
    const result = execFileSync("curl", [
      "-s",
      "-L",
      "-A",
      UA2,
      "-H",
      "Accept: text/html,*/*",
      "-H",
      `Referer: ${referer}`,
      "--max-redirs",
      "5",
      "--connect-timeout",
      "15",
      "--max-time",
      "30",
      "-w",
      "\n%{http_code}",
      url
    ], { encoding: "utf8", timeout: 35e3 });
    const lines = result.trim().split("\n");
    const httpCode = lines[lines.length - 1];
    const body = lines.slice(0, -1).join("\n");
    if (httpCode !== "200") {
      return { body: body.slice(0, 300), error: `HTTP ${httpCode}` };
    }
    return { body, error: null };
  } catch (err) {
    const e = err;
    return { body: "", error: e.message };
  }
}
async function axiosFetch(url, referer) {
  try {
    const resp = await axios6.get(url, {
      timeout: 15e3,
      headers: {
        "User-Agent": UA2,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer
      },
      maxRedirects: 5
    });
    return { body: resp.data, error: null };
  } catch (err) {
    const e = err;
    return { body: "", error: `HTTP ${e.response?.status || "unknown"}: ${e.message}` };
  }
}
async function extractDghg(embedUrl, skipData) {
  const curl = isCurlAvailable();
  logger.info({ embedUrl: embedUrl.slice(0, 100), curl }, "[DGHG] starting extraction");
  let html;
  let step1Error = null;
  if (curl) {
    const r = curlFetch(embedUrl, "https://aniwaves.ru/");
    html = r.body;
    step1Error = r.error;
  } else {
    const r = await axiosFetch(embedUrl, "https://aniwaves.ru/");
    html = r.body;
    step1Error = r.error;
  }
  if (!html || step1Error) {
    logger.error({ error: step1Error }, "[DGHG] Step 1 FAILED");
    return {
      source: null,
      debug: { curlAvailable: curl, step: "fetch_embed", detail: step1Error || "empty response", embedUrl }
    };
  }
  let passMd5Path = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) passMd5Path = passMd5Match[1];
  let token = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }
  if (!passMd5Path || !token) {
    return {
      source: null,
      debug: { curlAvailable: curl, step: "extract_creds", detail: `passMd5=${!!passMd5Path}, token=${!!token}`, embedUrl }
    };
  }
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;
  let cdnBaseUrl;
  let step3Error = null;
  if (curl) {
    const r = curlFetch(passMd5Url, embedUrl);
    cdnBaseUrl = r.body;
    step3Error = r.error;
  } else {
    const r = await axiosFetch(passMd5Url, embedUrl);
    cdnBaseUrl = r.body;
    step3Error = r.error;
  }
  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http") || step3Error) {
    return {
      source: null,
      debug: { curlAvailable: curl, step: "fetch_pass_md5", detail: step3Error || `invalid: ${cdnBaseUrl?.slice(0, 50)}`, embedUrl }
    };
  }
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;
  logger.info({ finalUrl: finalUrl.slice(0, 120) }, "[DGHG] extraction SUCCESS");
  let intro = null;
  let outro = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }
  return {
    source: {
      type: "direct",
      provider: "dghg",
      m3u8: finalUrl,
      subtitles: [],
      thumbnails: null,
      intro,
      outro
    },
    debug: null
  };
}

// src/lib/anime/providers/index.ts
async function extractStream(embedUrl, serverName, skipData) {
  const lowerName = serverName.toLowerCase();
  logger.info(
    { embedUrl: embedUrl.slice(0, 80), serverName },
    "dispatching to provider extractor"
  );
  if (isPlaymogoHost(embedUrl) || lowerName.includes("dghg") || lowerName.includes("myvidplay")) {
    logger.info({ serverName }, "routing to DGHG/PlayMogo extractor");
    const result = await extractDghg(embedUrl, skipData);
    if (result.debug) {
      logger.warn({ serverName, debug: result.debug }, "DGHG extraction failed");
    }
    return result.source;
  }
  if (isWeneverbeenfreeHost(embedUrl) || lowerName.includes("byfms") || lowerName.includes("weneverbeenfree")) {
    logger.info({ serverName }, "routing to WeneverBeenFree extractor");
    return extractWeneverbeenfree(embedUrl, skipData);
  }
  if (isEchovideoHost(embedUrl) || lowerName.includes("echo")) {
    logger.info({ serverName }, "routing to Echovideo extractor");
    return extractEchovideo(embedUrl, skipData);
  }
  if (isMegacloudHost(embedUrl) || lowerName.includes("megacloud") || lowerName.includes("rapidcloud") || lowerName.includes("rabbitstream") || lowerName.includes("mycloud")) {
    logger.info({ serverName }, "routing to MegaCloud extractor");
    return extractMegacloud(embedUrl);
  }
  if (isVidplayHost(embedUrl) || lowerName.includes("vidplay") || lowerName.includes("vidcloud")) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 80) },
    "unknown provider, trying all extractors in order"
  );
  if (/\/embed-\d+\//.test(embedUrl)) {
    const echoResult = await extractEchovideo(embedUrl, skipData);
    if (echoResult?.m3u8) return echoResult;
  }
  const vidplayResult = await extractVidplay(embedUrl);
  if (vidplayResult?.m3u8) return vidplayResult;
  const megacloudResult = await extractMegacloud(embedUrl);
  if (megacloudResult?.m3u8) return megacloudResult;
  const wnbfResult = await extractWeneverbeenfree(embedUrl, skipData);
  if (wnbfResult?.m3u8) return wnbfResult;
  const dghgResult = await extractDghg(embedUrl, skipData);
  if (dghgResult.source?.m3u8) return dghgResult.source;
  logger.error({ serverName, embedUrl: embedUrl.slice(0, 80) }, "all extractors failed");
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
  req.log.debug({ servers: servers.map((s) => s.name) }, "available servers");
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
    req.log.info(
      { serverName: targetServer.name, linkId: targetServer.id.slice(0, 30) },
      "trying specific server (no fallback)"
    );
    const sourcesResult = await getEmbedUrl(targetServer.id, id);
    if (!sourcesResult?.url) {
      res.status(502).json({ error: `Could not resolve embed URL for server "${serverName}"` });
      return;
    }
    const streamResult = await extractStream(sourcesResult.url, targetServer.name, {
      intro: sourcesResult.skip_data?.intro,
      outro: sourcesResult.skip_data?.outro
    });
    const stream = streamResult;
    if (stream?.m3u8) {
      req.log.info({ serverName: targetServer.name, m3u8: stream.m3u8.slice(0, 60) }, "stream extracted");
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
    req.log.info(
      { serverName: server.name, linkId: server.id.slice(0, 30) },
      "trying server"
    );
    const sourcesResult = await getEmbedUrl(server.id, id);
    if (!sourcesResult?.url) {
      req.log.warn({ serverName: server.name }, "could not resolve embed URL \u2014 skipping");
      failedServers.push(server.name);
      continue;
    }
    const stream = await extractStream(sourcesResult.url, server.name, {
      intro: sourcesResult.skip_data?.intro,
      outro: sourcesResult.skip_data?.outro
    });
    if (stream?.m3u8) {
      req.log.info({ serverName: server.name, m3u8: stream.m3u8.slice(0, 60) }, "stream extracted");
      res.json({ ...stream, _server: server.name, _failedServers: failedServers });
      return;
    }
    req.log.warn(
      { serverName: server.name },
      "extraction failed \u2014 trying next server"
    );
    failedServers.push(server.name);
  }
  res.status(502).json({
    error: "All servers failed \u2014 check logs for stage-by-stage detail",
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
    const host = targetUrl.hostname;
    if (host.includes("echovideo") || host.includes("echo")) {
      referer = "https://play.echovideo.ru/";
    } else if (host.includes("weneverbeenfree") || host.includes("owphbf") || host.includes("sprintcdn")) {
      referer = "https://weneverbeenfree.com/";
    } else {
      referer = "https://play.echovideo.ru/";
    }
  }
  req.log.info(
    { url: urlParam.slice(0, 80), referer },
    "proxying stream URL"
  );
  try {
    const upstream = await axios7.get(urlParam, {
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
        const encodedReferer = encodeURIComponent(referer ?? "https://play.echovideo.ru/");
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
    req.log.error(
      { url: urlParam.slice(0, 80), error: e.message, status: e.response?.status },
      "proxy request failed"
    );
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
var __dirname = path.dirname(fileURLToPath(import.meta.url));
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
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
var app_default = app;

// src/index.ts
var rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided."
  );
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
  logger.info({ port }, "Server listening");
});
//# sourceMappingURL=index.mjs.map
