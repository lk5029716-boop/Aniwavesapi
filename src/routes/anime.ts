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
 *
 * When a specific server name is given, only tries that server (no fallback).
 * When no server is given, tries all in order.
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

  // 2. If a specific server was requested, only try that server (no fallback)
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
      outro: sourcesResult.skip_data?.outro,
    });

    const stream = streamResult;

    if (stream?.m3u8) {
      req.log.info({ serverName: targetServer.name, m3u8: stream.m3u8.slice(0, 60) }, "stream extracted");
      res.json({ ...stream, _server: targetServer.name });
      return;
    }

    res.status(502).json({
      error: `Server "${serverName}" failed to extract stream`,
      server: targetServer.name,
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
 *
 * Proxies a stream URL (m3u8, ts segment, vtt, etc.) through the server
 * with the correct Referer / Origin headers that the CDN requires.
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

        // Compute base URL for resolving relative paths
        const baseUrl = urlParam.substring(0, urlParam.lastIndexOf("/") + 1);

        const rewritten = body
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();

            if (!trimmed) return line;

            // Tag lines with URI="..." (e.g. #EXT-X-KEY) — rewrite the URI value
            if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
                const abs = uri.startsWith("http") ? uri : baseUrl + uri;
                return `URI="/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
              });
            }

            // Other tag lines — pass through unchanged
            if (trimmed.startsWith("#")) return line;

            // Segment / sub-playlist URL (relative or absolute) — proxy it
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

export default router;
