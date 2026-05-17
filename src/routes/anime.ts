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
 * GET /api/servers?id=naruto-76396&ep=1&type=sub
 */
router.get("/servers", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"])
    ? req.query["ep"][0]
    : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"])
    ? req.query["type"][0]
    : req.query["type"];

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
  const type: "sub" | "dub" | "raw" =
    typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const servers = await getServers(id, ep, type);
  res.json({ servers });
});

/**
 * GET /api/stream?id=naruto-76396&ep=1&type=sub&server=vidplay
 */
router.get("/stream", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"])
    ? req.query["ep"][0]
    : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"])
    ? req.query["type"][0]
    : req.query["type"];
  const serverParam = Array.isArray(req.query["server"])
    ? req.query["server"][0]
    : req.query["server"];

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

  const type: "sub" | "dub" | "raw" =
    typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const serverName = typeof serverParam === "string" ? serverParam : null;

  req.log.info({ id, ep, type, server: serverName }, "stream requested");

  // 1. Get server list
  const servers = await getServers(id, ep, type);
  if (servers.length === 0) {
    res.status(404).json({ error: "No servers found for this episode/type" });
    return;
  }

  req.log.debug({ servers: servers.map((s) => s.name) }, "available servers");

  // 2. If a specific server was requested, only try that server
  if (serverName) {
    const targetServer = servers.find((s) =>
      s.name.toLowerCase().includes(serverName.toLowerCase())
    );

    if (!targetServer) {
      res.status(404).json({
        error: `Server "${serverName}" not available for this episode`,
        availableServers: servers.map((s) => s.name),
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
      outro: sourcesResult.skip_data?.outro,
    });

    if (stream?.m3u8) {
      req.log.info({ serverName: targetServer.name, m3u8: stream.m3u8.slice(0, 60) }, "stream extracted");
      res.json({ ...stream, _server: targetServer.name });
      return;
    }

    // Include DGHG debug info if available
    const dghgDebug = stream && '_dghgDebug' in stream ? (stream as Record<string, unknown>)._dghgDebug : null;

    res.status(502).json({
      error: `Server "${serverName}" failed to extract stream`,
      server: targetServer.name,
      debug: dghgDebug,
    });
    return;
  }

  // 3. No specific server — try all in order until one succeeds
  const failedServers: string[] = [];

  for (const server of servers) {
    req.log.info(
      { serverName: server.name, linkId: server.id.slice(0, 30) },
      "trying server"
    );

    const sourcesResult = await getEmbedUrl(server.id, id);
    if (!sourcesResult?.url) {
      req.log.warn({ serverName: server.name }, "could not resolve embed URL — skipping");
      failedServers.push(server.name);
      continue;
    }

    const stream = await extractStream(sourcesResult.url, server.name, {
      intro: sourcesResult.skip_data?.intro,
      outro: sourcesResult.skip_data?.outro,
    });

    if (stream?.m3u8) {
      req.log.info({ serverName: server.name, m3u8: stream.m3u8.slice(0, 60) }, "stream extracted");
      res.json({ ...stream, _server: server.name, _failedServers: failedServers });
      return;
    }

    req.log.warn(
      { serverName: server.name },
      "extraction failed — trying next server"
    );
    failedServers.push(server.name);
  }

  res.status(502).json({
    error: "All servers failed — check logs for stage-by-stage detail",
    failedServers,
  });
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

/**
 * GET /api/debug/dghg?id=naruto-76396&ep=1&type=sub
 * Temporary debug endpoint for DGHG extraction
 */
router.get("/debug/dghg", async (req, res): Promise<void> => {
  const steps: Record<string, unknown> = {};

  try {
    // Step 1: Test Playwright import
    steps.step1_import = "starting";
    try {
      const pw = await import("playwright");
      steps.step1_import = "ok";
      steps.playwrightKeys = Object.keys(pw);
    } catch (e) {
      steps.step1_import = `failed: ${(e as Error).message}`;
      res.json(steps);
      return;
    }

    // Step 2: Test Chromium launch
    steps.step2_launch = "starting";
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
      steps.step2_launch = "ok";
      await browser.close();
      steps.step2_close = "ok";
    } catch (e) {
      steps.step2_launch = `failed: ${(e as Error).message}`;
      res.json(steps);
      return;
    }

    // Step 3: Get servers
    const id = Array.isArray(req.query["id"]) ? req.query["id"][0] : req.query["id"];
    const epRaw = Array.isArray(req.query["ep"]) ? req.query["ep"][0] : req.query["ep"];
    const typeRaw = Array.isArray(req.query["type"]) ? req.query["type"][0] : req.query["type"];
    const ep = parseInt(String(epRaw), 10);
    const type: "sub" | "dub" | "raw" = typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";

    steps.step3_servers = "starting";
    const servers = await getServers(String(id), ep, type);
    steps.step3_servers = `ok, count=${servers.length}`;
    steps.serverNames = servers.map((s: { name: string }) => s.name);

    const dghgServer = servers.find((s: { name: string }) => s.name.toLowerCase().includes("dghg"));
    steps.dghgFound = !!dghgServer;

    if (!dghgServer) {
      res.json(steps);
      return;
    }

    // Step 4: Get embed URL
    steps.step4_embed = "starting";
    const sourcesResult = await getEmbedUrl(dghgServer.id, String(id));
    steps.step4_embed = sourcesResult?.url ? `ok: ${sourcesResult.url.slice(0, 80)}` : "no url";

    if (!sourcesResult?.url) {
      res.json(steps);
      return;
    }

    // Step 5: Navigate to embed page
    steps.step5_nav = "starting";
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        extraHTTPHeaders: { Referer: "https://aniwaves.ru/" },
      });
      const page = await context.newPage();
      await page.goto(sourcesResult.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e: Error) => {
        steps.step5_nav_error = e.message;
      });
      const html = await page.content();
      steps.step5_htmlLength = html.length;
      steps.step5_pageTitle = await page.title().catch(() => "unknown");
      steps.step5_pageUrl = page.url();

      const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
      steps.step5_hasPassMd5 = !!passMd5Match;
      steps.step5_passMd5Path = passMd5Match?.[1]?.slice(0, 100) ?? null;

      await browser.close();
      steps.step5_close = "ok";
    } catch (e) {
      steps.step5_nav = `failed: ${(e as Error).message}`;
    }

    res.json(steps);
  } catch (e) {
    steps.fatal = `${(e as Error).message}`;
    steps.stack = (e as Error).stack?.split("\n").slice(0, 5).join("\n");
    res.json(steps);
  }
});

export default router;
