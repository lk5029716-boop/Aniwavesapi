var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/logger.ts
import pino from "pino";
var isProduction, logger;
var init_logger = __esm({
  "src/lib/logger.ts"() {
    isProduction = process.env.NODE_ENV === "production";
    logger = pino({
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
  }
});

// src/lib/anime/providers/dghg.ts
var dghg_exports = {};
__export(dghg_exports, {
  extractDghg: () => extractDghg,
  isDghgEmbedUrl: () => isDghgEmbedUrl,
  isDghgServer: () => isDghgServer
});
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
function dghgHttpScript() {
  if (process.env["DGHG_HTTP_SCRIPT"]) return process.env["DGHG_HTTP_SCRIPT"];
  const dir = import.meta.dirname || process.cwd();
  const candidates = [
    join(dir, "dghg_http.py"),
    join(process.cwd(), "dghg_http.py"),
    "/opt/render/project/src/dghg_http.py",
    join(dir, "..", "..", "..", "dghg_http.py")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
function pythonBin() {
  return process.env["DGHG_PYTHON"] || "python3";
}
function isDghgEmbedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("myvidplay") || host.includes("playmogo");
  } catch {
    return false;
  }
}
function isDghgServer(serverName) {
  const n = serverName.toLowerCase();
  return n.includes("dghg") || n.includes("dood") || n.includes("playmogo");
}
function extractM3u8Url(body) {
  const candidates = [];
  let idx = 0;
  while (true) {
    const start = body.indexOf("http", idx);
    if (start === -1) break;
    let end = start;
    while (end < body.length) {
      const ch = body[end];
      if (ch === '"' || ch === "'" || ch === " " || ch === "\n" || ch === "\r" || ch === ")" || ch === ">" || ch === "<") break;
      end++;
    }
    if (end > start) candidates.push(body.slice(start, end));
    idx = end + 1;
  }
  if (candidates.length === 0) return null;
  const m3u8 = candidates.find((c) => /\.m3u8/i.test(c));
  const cdn = candidates.find((c) => /cloudatacdn\.com|cdn|\.m3u8/i.test(c));
  const clean = candidates.find((c) => !/http-equiv|w3\.org|schema\.org/i.test(c));
  return m3u8 ?? cdn ?? clean ?? null;
}
async function extractDghgHttp(embedUrl) {
  try {
    const out = execFileSync(pythonBin(), [dghgHttpScript(), embedUrl], {
      timeout: 25e3,
      encoding: "utf8",
      env: { ...process.env, PYTHONUNBUFFERED: "1" }
    });
    const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
    if (parsed.ok && parsed.m3u8) {
      logger.info({ m3u8: String(parsed.m3u8).slice(0, 80) }, "[DGHG-http] OK");
      return { m3u8: parsed.m3u8, cfWall: false };
    }
    logger.warn({ reason: parsed.reason, status: parsed.status, len: parsed.len, title: parsed.title }, "[DGHG-http] no m3u8");
    return { m3u8: null, cfWall: parsed.reason === "cf-wall", reason: parsed.reason, detail: parsed };
  } catch (e) {
    logger.warn({ error: String(e?.message || e).slice(0, 160) }, "[DGHG-http] exec failed");
    return { m3u8: null, cfWall: false, reason: "exec-failed" };
  }
}
async function extractDghg(embedUrl, skipData, _proxyUrl) {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] start");
  const host = (() => {
    try {
      return new URL(embedUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (!host.includes("myvidplay") && !host.includes("playmogo")) {
    logger.warn({ embedUrl }, "[DGHG] not a dghg host, skipping");
    return null;
  }
  const http = await extractDghgHttp(embedUrl);
  if (http.m3u8) {
    let intro = null;
    let outro = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    return { type: "direct", provider: "dghg", m3u8: http.m3u8, subtitles: [], thumbnails: null, intro, outro };
  }
  if (!process.env["DGHG_BROWSER_FALLBACK"]) {
    const reason = http.reason || (http.cfWall ? "cf-wall" : "http-failed");
    const detail = http.detail ? ` | len=${http.detail.len} title=${http.detail.title} snippet=${(http.detail.snippet || "").slice(0, 200)}` : "";
    logger.warn({ cfWall: http.cfWall, reason, detail }, "[DGHG] HTTP path failed; browser fallback disabled");
    throw new Error(`DGHG_HTTP_FAILED:${reason}${detail}`);
  }
  logger.warn("[DGHG] HTTP path yielded nothing \u2014 falling back to Playwright browser");
  return extractDghgBrowser(embedUrl, skipData, _proxyUrl);
}
async function extractDghgBrowser(embedUrl, skipData, _proxyUrl) {
  let browser = null;
  try {
    const proxyRaw = _proxyUrl || process.env["DGHG_PROXY_URL"] || process.env["HTTPS_PROXY"] || null;
    let launchProxy;
    if (proxyRaw) {
      try {
        const u = new URL(proxyRaw);
        launchProxy = {
          server: `${u.protocol || "http:"}//${u.hostname}${u.port ? ":" + u.port : ""}`
        };
        if (u.username) launchProxy.username = decodeURIComponent(u.username);
        if (u.password) launchProxy.password = decodeURIComponent(u.password);
      } catch {
        launchProxy = { server: proxyRaw };
      }
      logger.info({ server: launchProxy.server }, "[DGHG-browser] using proxy");
    }
    browser = await chromium.launch({
      headless: true,
      proxy: launchProxy,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--headless=new"
      ]
    });
    const ctx = await browser.newContext({
      userAgent: DGHG_UA,
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York"
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => void 0 });
      const navAny = navigator;
      if (!navAny.chrome) {
        Object.defineProperty(navigator, "chrome", { get: () => ({ runtime: {} }), configurable: true });
      }
    });
    let m3u8 = null;
    let passMd5Url = null;
    page.on("response", (resp) => {
      if (/\/pass_md5\//i.test(resp.url())) passMd5Url = resp.url();
    });
    for (let attempt = 1; attempt <= 3 && !m3u8; attempt++) {
      try {
        await page.goto(embedUrl, { waitUntil: "commit", timeout: 25e3 });
      } catch (navErr) {
        logger.warn({ error: String(navErr).slice(0, 100) }, "[DGHG-browser] goto error, retrying");
      }
      try {
        await page.waitForFunction(
          () => document.title && !/just a moment/i.test(document.title),
          { timeout: 2e4 }
        );
      } catch {
        logger.warn({ title: await page.title().catch(() => "") }, "[DGHG-browser] CF wall still up");
      }
      const resp = await page.waitForResponse((r) => /\/pass_md5\//i.test(r.url()), { timeout: 2e4 }).catch(() => null);
      if (resp) {
        passMd5Url = resp.url();
        try {
          const body = await resp.text();
          const hit = extractM3u8Url(body);
          if (hit) m3u8 = hit;
        } catch (e) {
          logger.warn({ error: String(e).slice(0, 120) }, "[DGHG-browser] pass_md5 body read failed");
        }
      }
      if (!m3u8) {
        try {
          const dom = await page.evaluate(() => {
            const v = document.querySelector("video");
            const s = document.querySelector("source");
            const a = document.querySelector("a[href*='.m3u8']");
            return { v: v?.getAttribute("src") || null, s: s?.getAttribute("src") || null, a: a?.getAttribute("href") || null };
          });
          const cand = dom.v || dom.s || dom.a;
          if (cand && cand.includes(".m3u8")) m3u8 = cand;
        } catch {
        }
      }
      logger.info({ attempt, passMd5: !!passMd5Url, m3u8: !!m3u8 }, "[DGHG-browser] load attempt");
    }
    if (!m3u8) {
      const finalUrl = page.url();
      let title = "";
      let snippet = "";
      try {
        title = await page.title();
        snippet = (await page.content()).slice(0, 400);
      } catch {
      }
      logger.warn({ passMd5: !!passMd5Url, finalUrl, title }, "[DGHG-browser] could not extract m3u8");
      return {
        type: "direct",
        provider: "dghg",
        m3u8: null,
        subtitles: [],
        thumbnails: null,
        intro: null,
        outro: null,
        _diag: {
          path: "browser",
          cfWallUp: /just a moment/i.test(title),
          proxyUsed: !!launchProxy,
          passMd5Seen: !!passMd5Url,
          finalUrl,
          title,
          pageSnippet: snippet
        }
      };
    }
    logger.info({ m3u8: m3u8.slice(0, 80) }, "[DGHG-browser] OK");
    let intro = null;
    let outro = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    return { type: "direct", provider: "dghg", m3u8, subtitles: [], thumbnails: null, intro, outro };
  } catch (e) {
    logger.warn({ error: String(e).slice(0, 200) }, "[DGHG-browser] exception, skipping");
    return null;
  } finally {
    await browser?.close().catch(() => {
    });
  }
}
var init_dghg = __esm({
  "src/lib/anime/providers/dghg.ts"() {
    init_logger();
  }
});

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
import { execSync } from "child_process";
var router = Router();
router.get("/health", async (_req, res) => {
  let curlAvailable = false;
  let chromiumPath = null;
  let playwrightVersion = null;
  let chromiumLaunchTest = null;
  try {
    execSync("which curl", { encoding: "utf8", timeout: 5e3 });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }
  try {
    chromiumPath = execSync(
      "find /ms-playwright -name chrome -type f 2>/dev/null | head -1",
      { encoding: "utf8", timeout: 5e3 }
    ).trim();
  } catch {
    chromiumPath = null;
  }
  try {
    const pw = await import("playwright");
    playwrightVersion = pw?.chromium ? "available" : "unknown";
  } catch {
    playwrightVersion = "not available";
  }
  if (chromiumPath) {
    try {
      const { chromium: chromium2 } = await import("playwright");
      const browser = await chromium2.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      await browser.close();
      chromiumLaunchTest = "success";
    } catch (e) {
      chromiumLaunchTest = `failed: ${e.message.slice(0, 100)}`;
    }
  }
  let curlCffiAvailable = false;
  try {
    execSync(`python3 -c 'from curl_cffi import requests; print("ok")'`, { encoding: "utf8", timeout: 5e3 });
    curlCffiAvailable = true;
  } catch {
    curlCffiAvailable = false;
  }
  const scraperPath = process.env["ANIWAVES_SCRAPER_PATH"] || "";
  res.json({
    status: "ok",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    curl: curlAvailable,
    curlCffi: curlCffiAvailable,
    scraperPath: scraperPath || "(not set)",
    node: process.version,
    env: process.env.NODE_ENV || "development",
    chromium: chromiumPath || "not found",
    playwright: playwrightVersion,
    chromiumLaunchTest
  });
});
var health_default = router;

// src/routes/anime.ts
import { Router as Router2 } from "express";
import axios5 from "axios";

// src/lib/anime/scraper.ts
init_logger();
import axios from "axios";
import * as cheerio from "cheerio";

// src/lib/anime/cache.ts
import NodeCache from "node-cache";
var cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
function cacheGet(key) {
  return cache.get(key);
}
function cacheSet(key, value, ttl = 300) {
  cache.set(key, value, ttl);
}

// src/lib/anime/proxy.ts
init_logger();
var PROXY_BASE = (process.env["ANIWAVES_PROXY_URL"] ?? "").trim();
var PROXIED_HOSTS = [
  "aniwaves.ru",
  "echovideo.ru",
  "echovideo.to",
  "play.echovideo.ru",
  "myvidplay.com",
  "playmogo.com",
  "gn1r5n.org",
  "weneverbeenfree.com"
];
var warned = false;
function proxyEnabled() {
  return PROXY_BASE.length > 0;
}
function shouldProxy(url) {
  try {
    const host = new URL(url).hostname;
    return PROXIED_HOSTS.some(
      (h) => host === h || host.endsWith("." + h)
    );
  } catch {
    return false;
  }
}
function maybeProxy(url) {
  if (!proxyEnabled() || !shouldProxy(url)) return url;
  if (!warned) {
    warned = true;
    logger.info(
      { proxy: PROXY_BASE.slice(0, 40) },
      "[proxy] routing Cloudflare-fronted requests through CF Worker"
    );
  }
  const sep = PROXY_BASE.includes("?") ? "&" : "?";
  return `${PROXY_BASE}${sep}url=${encodeURIComponent(url)}`;
}
function proxyHeaders(headers) {
  if (!proxyEnabled()) return headers;
  const out = { ...headers };
  delete out["Referer"];
  delete out["Origin"];
  return out;
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
  const resp = await ajaxClient.get(maybeProxy("/ajax/anime/search"), {
    headers: proxyHeaders({
      "X-Requested-With": "XMLHttpRequest",
      Referer: BASE_URL
    }),
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
  const slugMatch = animeId.match(/-(\d+)$/);
  if (slugMatch) {
    const numericId2 = slugMatch[1];
    cacheSet(cacheKey, numericId2, 86400);
    return numericId2;
  }
  const resp = await client.get(maybeProxy(`/watch/${animeId}`));
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
  const resp = await ajaxClient.get(maybeProxy(`/ajax/episode/list/${numericId}`), {
    headers: proxyHeaders({
      Referer: `${BASE_URL}/watch/${animeId}`,
      "X-Requested-With": "XMLHttpRequest"
    })
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
      const compositeId = `${animeId}-ep-${num}`;
      episodes.push({ number: num, id: compositeId, rawId: dataIds, title, isFiller });
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
  if (!episode.rawId) {
    logger.warn({ animeId, ep }, "episode has no rawId");
    return [];
  }
  const [animeNumId, epsNum] = episode.rawId.split("&eps=");
  if (!animeNumId || !epsNum) {
    logger.warn({ animeId, ep, rawId: episode.rawId }, "could not parse rawId");
    return [];
  }
  const resp = await ajaxClient.get(maybeProxy("/ajax/server/list"), {
    params: { servers: animeNumId, eps: epsNum },
    headers: proxyHeaders({
      Referer: `${BASE_URL}/watch/${animeId}`,
      "X-Requested-With": "XMLHttpRequest"
    })
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
    if (type !== "raw" && serverType !== type) {
      if (!(type === "sub" && serverType === "ssub")) return;
    }
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
  const resp = await ajaxClient.get(maybeProxy("/ajax/sources"), {
    params: { id: linkId },
    headers: proxyHeaders({
      "X-Requested-With": "XMLHttpRequest",
      Referer: refererAnimeId ? `${BASE_URL}/watch/${refererAnimeId}` : BASE_URL
    })
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

// src/lib/anime/providers/index.ts
init_logger();

// src/lib/anime/providers/vidplay.ts
init_logger();
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
init_logger();
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
init_logger();
import axios4 from "axios";

// src/lib/anime/providers/playwright-extractor.ts
init_logger();
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
    const { chromium: chromium2 } = await import("playwright-core");
    browser = await chromium2.launch({
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
    const pageResp = await axios4.get(maybeProxy(embedUrl), { timeout: 1e4, headers: commonHeaders });
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
    const resp = await axios4.get(maybeProxy(sourcesUrl), {
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
init_logger();
import https2 from "https";
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ANIWAVES_REFERER2 = "https://aniwaves.ru/";
var ANIWAVES_ORIGIN2 = "https://aniwaves.ru";
var BE = 512;
var DR = 2;
var LR = 2654435761;
var HR = 2246822519;
var rotl = (t, e) => (t << e | t >>> 32 - e) >>> 0;
var mul32 = (t, e) => Math.imul(t, e) >>> 0;
function ye(t) {
  t[0] = t[0] + t[1] >>> 0;
  t[3] = rotl(t[3] ^ t[0], 16);
  t[2] = t[2] + t[3] >>> 0;
  t[1] = rotl(t[1] ^ t[2], 12);
  t[0] = t[0] + t[1] >>> 0;
  t[3] = rotl(t[3] ^ t[0], 8);
  t[2] = t[2] + t[3] >>> 0;
  t[1] = rotl(t[1] ^ t[2], 7);
}
function gr(t) {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < t.length; i++) {
    e[0] = e[0] + t[i] >>> 0;
    e[0] = rotl(e[0], 7);
    ye(e);
  }
  for (let i = 0; i < 8; i++) ye(e);
  const r = new Uint32Array(BE);
  for (let i = 0; i < BE; i++) {
    ye(e);
    r[i] = (e[0] ^ e[2]) >>> 0;
  }
  for (let i = 0; i < DR; i++)
    for (let s = 0; s < BE; s++) {
      const a = r[s] & BE - 1;
      let c = r[s] + r[a] >>> 0;
      c = rotl(c, 13);
      c = (c ^ mul32(r[s + 1 & BE - 1], LR)) >>> 0;
      r[s] = c;
      e[0] = (e[0] ^ c) >>> 0;
      ye(e);
    }
  const n = new Uint32Array(8), o = BE / 8;
  for (let i = 0; i < 8; i++) {
    ye(e);
    let s = e[0];
    const a = i * o;
    for (let c = 0; c < o; c++) {
      const d = r[a + c];
      s = s + d >>> 0;
      s = rotl(s, 5);
      s = (s ^ mul32(d, HR)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}
function yr(str) {
  const e = new Uint8Array(str.length);
  for (let r = 0; r < str.length; r++) e[r] = str.charCodeAt(r) & 255;
  return e;
}
function wr(t) {
  let e = 0;
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    if (n === 0) {
      e += 32;
      continue;
    }
    return e + Math.clz32(n);
  }
  return e;
}
function minePoW(nonce, difficulty, timeoutMs = 2e4) {
  const start = Date.now();
  let s = 0;
  while (Date.now() - start < timeoutMs) {
    if (wr(gr(yr(`${nonce}:${s}`))) >= difficulty) return String(s);
    s++;
  }
  return null;
}
function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const rem = pad.length % 4;
  const p = rem ? pad + "=".repeat(4 - rem) : pad;
  return Uint8Array.from(Buffer.from(p, "base64"));
}
function Qa() {
  const e = {};
  for (let n = 1; n <= 20; n += 1) {
    const o = n ^ 0, a = 31 - n ^ 0;
    e[String(n)] = [o, a];
  }
  return e;
}
function Ea(version, total) {
  const r = typeof version === "string" ? version.trim() : "";
  const o = Qa()[r];
  if (!o) return [0, 0];
  const [a, i] = o;
  return a < 1 || i < 1 || a > total || i > total ? [0, 0] : [a, i];
}
function ws(playback) {
  const t = Array.isArray(playback.key_parts) ? playback.key_parts : [];
  const [a, i] = Ea(playback.version, t.length);
  if (a === 0 && i === 0) return t;
  const n = [a, i].map((o) => Number(o)).filter((o) => Number.isInteger(o) && o >= 1 && o <= t.length).map((o) => t[o - 1]).filter((o) => typeof o === "string" && o.length > 0);
  return n.length > 0 ? n : t;
}
function ks(parts) {
  const t = parts.filter((a) => typeof a === "string" && a.length > 0).map(b64urlToBytes);
  const r = t.reduce((a, i) => a + i.length, 0);
  const n = new Uint8Array(r);
  let o = 0;
  for (const a of t) {
    n.set(a, o);
    o += a.length;
  }
  return n;
}
async function decryptPlayback(playback) {
  const key = ks(ws(playback));
  const iv = b64urlToBytes(playback.iv);
  const ct = b64urlToBytes(playback.payload);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const cryptoKey = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
    return new TextDecoder().decode(plain);
  } catch (err) {
    logger.warn({ error: err.message }, "[WNBF] AES-GCM decrypt failed");
    return null;
  }
}
function postJson(host, path2, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https2.request(
      {
        hostname: host,
        path: path2,
        method: "POST",
        headers: {
          "User-Agent": UA2,
          "Content-Type": "application/json",
          "Referer": ANIWAVES_REFERER2,
          "Origin": ANIWAVES_ORIGIN2,
          "Accept": "application/json",
          ...headers,
          "Content-Length": Buffer.byteLength(data)
        }
      },
      (res) => {
        let d = "";
        res.on("data", (c) => d += c.toString());
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(d);
          } catch {
            json = d;
          }
          resolve({ status: res.statusCode ?? 0, body: json });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
async function extractWeneverbeenfree(embedUrl, skipData) {
  let videoId = null;
  let host = null;
  try {
    const u = new URL(embedUrl);
    host = u.hostname;
    const m = u.pathname.match(/\/e\/([A-Za-z0-9_-]+)/);
    if (m) videoId = m[1];
  } catch {
    logger.error({ embedUrl }, "[WNBF] invalid embed URL");
    return null;
  }
  if (!videoId || !host) {
    logger.error({ embedUrl }, "[WNBF] could not parse video id from embed URL");
    return null;
  }
  logger.info({ videoId, host }, "[WNBF] starting PoW-gated extraction");
  try {
    const c = await postJson(host, `/api/videos/${videoId}/captcha`, {});
    if (c.status !== 200 || !c.body?.pow_nonce) {
      logger.error({ status: c.status, body: JSON.stringify(c.body).slice(0, 120) }, "[WNBF] captcha challenge failed");
      return null;
    }
    const { pow_nonce, pow_difficulty, pow_token } = c.body;
    const solution = minePoW(pow_nonce, pow_difficulty);
    if (!solution) {
      logger.error("[WNBF] PoW mining timed out");
      return null;
    }
    const v = await postJson(host, `/api/videos/${videoId}/captcha/verify`, {
      pow_token,
      solution
    });
    if (v.status !== 200 || v.body?.status !== "ok" || !v.body?.token) {
      logger.error({ status: v.status, body: JSON.stringify(v.body).slice(0, 120) }, "[WNBF] captcha verify failed");
      return null;
    }
    const capToken = v.body.token;
    const p = await postJson(
      host,
      `/api/videos/${videoId}/embed/playback`,
      { fingerprint: { token: capToken } },
      { "X-Captcha-Token": capToken }
    );
    if (p.status !== 200 || !p.body?.playback) {
      logger.error({ status: p.status, body: JSON.stringify(p.body).slice(0, 160) }, "[WNBF] playback request failed");
      return null;
    }
    const decrypted = await decryptPlayback(p.body.playback);
    if (!decrypted) {
      logger.error("[WNBF] could not decrypt playback payload");
      return null;
    }
    const parsed = JSON.parse(decrypted);
    const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
    const master = sources.find((s) => s?.mime_type?.includes("mpegurl") && s?.url?.includes("master"))?.url ?? sources.find((s) => s?.mime_type?.includes("mpegurl"))?.url ?? sources[0]?.url ?? null;
    if (!master) {
      logger.error("[WNBF] no m3u8 url in decrypted payload");
      return null;
    }
    logger.info({ m3u8: master.slice(0, 130) }, "[WNBF] extraction SUCCESS");
    let intro = null;
    let outro = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }
    const subtitles = [];
    return {
      type: "direct",
      provider: "byfms",
      m3u8: master,
      subtitles,
      thumbnails: parsed?.poster_url ?? null,
      intro,
      outro
    };
  } catch (err) {
    logger.error({ error: err.message }, "[WNBF] fatal error");
    return null;
  }
}
function isWeneverbeenfreeHost(url) {
  try {
    const h = new URL(url).hostname;
    return h.includes("weneverbeenfree") || h.includes("wnbf") || h.includes("myvidplay") || h.includes("animefever") || h.includes("owphbf") || h.includes("sprintcdn");
  } catch {
    return false;
  }
}

// src/lib/anime/providers/index.ts
init_dghg();
var VIDPLAY_LIKE_HOSTS = [
  "vidplay.online",
  "vidplay.lol",
  "vidcloud.lol",
  "mcloud.bz",
  "vidstreaming.io",
  "goload.pro"
];
var MEGACLOUD_LIKE_HOSTS = [
  "megacloud.tv",
  "rapid-cloud.co",
  "rabbitstream.net"
];
var WNBF_LIKE_HOSTS = [
  "weneverbeenfree.com"
];
var ECHOVIDEO_LIKE_HOSTS = [
  "play.echovideo.ru",
  "echovideo.ru"
];
function matchHost(url, hostList) {
  try {
    const host = new URL(url).hostname;
    return hostList.some((h) => host.includes(h));
  } catch {
    return false;
  }
}
async function extractStream(embedUrl, serverName, skipData, proxyUrl) {
  const lowerName = serverName.toLowerCase();
  logger.info(
    { embedUrl: embedUrl.slice(0, 90), serverName },
    "dispatching to provider extractor"
  );
  if (matchHost(embedUrl, ECHOVIDEO_LIKE_HOSTS) || isEchovideoHost(embedUrl)) {
    logger.info({ serverName }, "routing to Echovideo extractor");
    return extractEchovideo(embedUrl, skipData);
  }
  if (isDghgServer(serverName) || isDghgEmbedUrl(embedUrl) || lowerName.includes("dood") || lowerName.includes("playmogo")) {
    logger.info({ serverName, host: new URL(embedUrl).hostname }, "routing to DGHG extractor");
    return extractDghg(embedUrl, skipData, proxyUrl);
  }
  if (matchHost(embedUrl, WNBF_LIKE_HOSTS) || isWeneverbeenfreeHost(embedUrl) || lowerName.includes("byfms") || lowerName.includes("weneverbeenfree")) {
    logger.info({ serverName, host: new URL(embedUrl).hostname }, "routing to WeneverBeenFree extractor");
    return extractWeneverbeenfree(embedUrl, skipData);
  }
  if (matchHost(embedUrl, MEGACLOUD_LIKE_HOSTS) || isMegacloudHost(embedUrl) || lowerName.includes("megacloud") || lowerName.includes("rapidcloud") || lowerName.includes("rabbitstream")) {
    logger.info({ serverName }, "routing to MegaCloud extractor");
    return extractMegacloud(embedUrl);
  }
  if (matchHost(embedUrl, VIDPLAY_LIKE_HOSTS) || isVidplayHost(embedUrl) || lowerName.includes("vidplay") || lowerName.includes("vidcloud")) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 90) },
    "unknown provider host \u2014 running heuristic detection"
  );
  if (/\/embed-\d+\/[A-Za-z0-9_-]{20,}/.test(embedUrl)) {
    logger.info({ serverName }, "heuristic: looks like Echovideo (embed-N path)");
    const echoResult = await extractEchovideo(embedUrl, skipData);
    if (echoResult?.m3u8) return echoResult;
  }
  if (/\/e\/[a-z0-9]{10,16}/.test(embedUrl)) {
    logger.info({ serverName }, "heuristic: looks like WeneverBeenFree/MegaCloud (/e/ path)");
    const wnbfResult = await extractWeneverbeenfree(embedUrl, skipData);
    if (wnbfResult?.m3u8) return wnbfResult;
    const megaResult = await extractMegacloud(embedUrl);
    if (megaResult?.m3u8) return megaResult;
  }
  logger.warn({ serverName }, "trying all extractors in sequence as last resort");
  const attempts = [
    () => extractDghg(embedUrl, skipData),
    () => extractWeneverbeenfree(embedUrl, skipData),
    () => extractEchovideo(embedUrl, skipData),
    () => extractMegacloud(embedUrl),
    () => extractVidplay(embedUrl)
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
  const episodeIdRaw = Array.isArray(req.query["episodeId"]) ? req.query["episodeId"][0] : req.query["episodeId"];
  const idRaw = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"]) ? req.query["ep"][0] : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"]) ? req.query["type"][0] : req.query["type"];
  let animeId;
  let ep;
  if (episodeIdRaw && typeof episodeIdRaw === "string") {
    const match = episodeIdRaw.match(/^(.+)-ep-(\d+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid episodeId format. Expected: animeSlug-ep-N (e.g. naruto-76396-ep-1)" });
      return;
    }
    animeId = match[1];
    ep = parseInt(match[2], 10);
  } else if (idRaw && typeof idRaw === "string" && epRaw) {
    animeId = idRaw;
    ep = parseInt(String(epRaw), 10);
    if (isNaN(ep)) {
      res.status(400).json({ error: "param ep must be a number" });
      return;
    }
  } else {
    res.status(400).json({ error: "Provide either episodeId (e.g. naruto-76396-ep-1) or id + ep" });
    return;
  }
  const type = typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const servers = await getServers(animeId, ep, type);
  res.json({ servers });
});
router2.get("/stream", async (req, res) => {
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
  req.log.info({ embedUrl: sourcesResult.url, serverId: serverId.slice(0, 40) }, "resolved embed URL");
  const stream = await extractStream(sourcesResult.url, "direct", {
    intro: sourcesResult.skip_data?.intro,
    outro: sourcesResult.skip_data?.outro
  }, proxyUrl);
  if (stream?.m3u8) {
    const referer = stream.provider === "dghg" ? "https://playmogo.com/" : "https://play.echovideo.ru/";
    const proxiedM3u8 = `/api/proxy?url=${encodeURIComponent(stream.m3u8)}&referer=${encodeURIComponent(referer)}`;
    res.json({ ...stream, proxiedM3u8, _server: "direct" });
    return;
  }
  res.status(502).json({ error: "Stream extraction failed from serverId" });
});
router2.get("/debug-dghg", async (req, res) => {
  const embedUrl = req.query["embedUrl"];
  if (!embedUrl || typeof embedUrl !== "string") {
    res.status(400).json({ error: "embedUrl query param required" });
    return;
  }
  try {
    const { extractDghg: extractDghg2 } = await Promise.resolve().then(() => (init_dghg(), dghg_exports));
    const stream = await extractDghg2(embedUrl, void 0, process.env["ANIWAVES_PROXY_URL"] || null);
    if (stream?.m3u8) {
      res.json({ ok: true, result: { ok: true, m3u8: stream.m3u8, provider: stream.provider } });
    } else if (stream?._diag) {
      res.status(502).json({ ok: false, error: "extractDghg failed", diag: stream._diag });
    } else {
      res.status(502).json({ ok: false, error: "extractDghg returned no m3u8" });
    }
  } catch (err) {
    const e = err;
    res.status(502).json({
      ok: false,
      error: e.message,
      stderr: e.stderr?.toString().slice(0, 500),
      status: e.status,
      embedUrl: embedUrl.slice(0, 100)
    });
  }
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
    } else if (host.includes("owphbf") || host.includes("sprintcdn")) {
      referer = "https://aniwaves.ru/";
    } else if (host.includes("weneverbeenfree")) {
      referer = "https://aniwaves.ru/";
    } else if (host.includes("cloudatacdn")) {
      referer = "https://playmogo.com/";
    } else {
      referer = "https://play.echovideo.ru/";
    }
  }
  req.log.info(
    { url: urlParam.slice(0, 80), referer, range: req.headers["range"] ?? null },
    "proxying stream URL"
  );
  try {
    const upstream = await axios5.get(urlParam, {
      responseType: "stream",
      timeout: 3e4,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: "*/*",
        "Accept-Encoding": "identity",
        // Forward the browser's Range so the CDN returns a partial 206
        // (hls.js requests byte ranges; without this the player stalls at 0:00).
        ...req.headers["range"] ? { Range: req.headers["range"] } : {}
      },
      maxRedirects: 5,
      // Don't let axios throw on a 206 from the CDN.
      validateStatus: (s) => s < 400
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    res.setHeader("Accept-Ranges", "bytes");
    const chunks = [];
    upstream.data.on("data", (chunk) => chunks.push(chunk));
    upstream.data.on("end", () => {
      const full = Buffer.concat(chunks);
      const head = full.subarray(0, 64).toString("utf8");
      const isPlaylist = /^#EXTM3U/.test(head) || urlParam.includes(".m3u8");
      if (isPlaylist) {
        const body = full.toString("utf8");
        const encodedReferer = encodeURIComponent(referer ?? "https://play.echovideo.ru/");
        const origin = `${targetUrl.protocol}//${targetUrl.host}`;
        const baseUrl = urlParam.substring(0, urlParam.lastIndexOf("/") + 1);
        const toProxy = (raw) => {
          const abs = raw.startsWith("http") ? raw : raw.startsWith("/") ? origin + raw : baseUrl + raw;
          return `/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
        };
        const rewritten = body.split("\n").map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
              return `URI="${toProxy(uri)}"`;
            });
          }
          if (trimmed.startsWith("#")) return line;
          return toProxy(trimmed);
        }).join("\n");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.removeHeader("Content-Length");
        res.send(rewritten);
        req.log.info({ status: 200, kind: "playlist" }, "proxy playlist (rewritten)");
      } else {
        const total = full.length;
        const rangeHeader = req.headers["range"];
        const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? parseInt(match[2], 10) : total - 1;
          const clampedEnd = Math.min(end, total - 1);
          const slice = full.subarray(start, clampedEnd + 1);
          res.status(206);
          res.setHeader("Content-Type", "video/MP2T");
          res.setHeader("Content-Range", `bytes ${start}-${clampedEnd}/${total}`);
          res.setHeader("Content-Length", String(slice.length));
          res.send(slice);
          req.log.info({ status: 206, range: `${start}-${clampedEnd}/${total}`, len: slice.length }, "proxy segment (range)");
        } else {
          res.status(200);
          res.setHeader("Content-Type", "video/MP2T");
          res.setHeader("Content-Length", String(total));
          res.send(full);
          req.log.info({ status: 200, len: total }, "proxy segment (full)");
        }
      }
    });
    upstream.data.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "upstream stream error" });
    });
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
init_logger();
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
init_logger();
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
