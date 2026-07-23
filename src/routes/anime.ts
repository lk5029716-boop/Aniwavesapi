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
 * proxy: optional proxy URL
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

  req.log.info({ embedUrl: sourcesResult.url, serverId: serverId.slice(0, 40) }, "resolved embed URL");

  const stream = await extractStream(sourcesResult.url, "direct", {
    intro: sourcesResult.skip_data?.intro,
    outro: sourcesResult.skip_data?.outro,
  }, proxyUrl);

  if (stream?.m3u8) {
    // Browser can't load the raw CDN URL (CORS locked, content-type is
    // image/jpeg). Wrap it through our own /api/proxy so the client fetches
    // same-origin. appendSubFetch / relative segments are rewritten by the
    // proxy back into proxied URLs. The referer MUST match the CDN that owns
    // the m3u8: echovideo -> play.echovideo.ru, DGHG/DoodStream -> playmogo.com
    // (cloudatacdn rejects the echovideo referer -> "All servers failed").
    const referer =
      stream.provider === "dghg"
        ? "https://playmogo.com/"
        : "https://play.echovideo.ru/";
    const proxiedM3u8 = `/api/proxy?url=${encodeURIComponent(stream.m3u8)}&referer=${encodeURIComponent(referer)}`;
    res.json({ ...stream, proxiedM3u8, _server: "direct" });
    return;
  }

  res.status(502).json({ error: "Stream extraction failed from serverId" });
});

/**
 * GET /api/debug-dghg?embedUrl=...
 * Directly calls the Python scraper for DGHG extraction
 */
router.get("/debug-dghg", async (req, res): Promise<void> => {
  const embedUrl = req.query["embedUrl"];
  if (!embedUrl || typeof embedUrl !== "string") {
    res.status(400).json({ error: "embedUrl query param required" });
    return;
  }

  // Route through extractDghg. Primary path is pure-HTTP (Python urllib, which
  // passes Cloudflare's TLS fingerprint that Node fetch/curl_cffi fail on). No
  // browser or CF JS-challenge needed, so it works from datacenter IPs (Render).
  try {
    const { extractDghg } = await import("../lib/anime/providers/dghg.js");
    const stream = await extractDghg(embedUrl, undefined, process.env["ANIWAVES_PROXY_URL"] || null);
    if (stream?.m3u8) {
      res.json({ ok: true, result: { ok: true, m3u8: stream.m3u8, provider: stream.provider } });
    } else if ((stream as any)?._diag) {
      res.status(502).json({ ok: false, error: "extractDghg failed", diag: (stream as any)._diag });
    } else {
      res.status(502).json({ ok: false, error: "extractDghg returned no m3u8" });
    }
  } catch (err) {
    const e = err as Error & { stderr?: Buffer; status?: number };
    res.status(502).json({
      ok: false,
      error: e.message,
      stderr: e.stderr?.toString().slice(0, 500),
      status: e.status,
      embedUrl: embedUrl.slice(0, 100),
    });
  }
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
    } else if (host.includes("owphbf") || host.includes("sprintcdn")) {
      // BYFMS/Byse CDN: requires the aniwaves.ru referer (verified live).
      referer = "https://aniwaves.ru/";
    } else if (host.includes("weneverbeenfree")) {
      referer = "https://aniwaves.ru/";
    } else if (host.includes("cloudatacdn")) {
      // DGHG / DoodStream CDN: token is bound to the playmogo/myvidplay
      // referer; the echovideo default 403s the segments -> frontend "failed".
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
        // Forward the browser's Range so the CDN returns a partial 206
        // (hls.js requests byte ranges; without this the player stalls at 0:00).
        ...(req.headers["range"] ? { Range: req.headers["range"] as string } : {}),
      },
      maxRedirects: 5,
      // Don't let axios throw on a 206 from the CDN.
      validateStatus: (s) => s < 400,
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    res.setHeader("Accept-Ranges", "bytes");

    // Buffer the whole upstream response, then classify by CONTENT — echovideo
    // serves variant playlists AND segments from extension-less /cdn/<hash>
    // URLs, both with a bogus `image/jpeg` content-type. Routing by URL
    // extension mis-classifies variants as segments, so hls.js receives
    // image/jpeg for a media playlist and silently refuses to load fragments
    // (stuck at readyState 0 / 0:00). Detect playlists by the #EXTM3U body.
    const chunks: Buffer[] = [];
    upstream.data.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstream.data.on("end", () => {
      const full = Buffer.concat(chunks);
      const head = full.subarray(0, 64).toString("utf8");
      const isPlaylist = /^#EXTM3U/.test(head) || urlParam.includes(".m3u8");

      if (isPlaylist) {
        const body = full.toString("utf8");
        const encodedReferer = encodeURIComponent(referer ?? "https://play.echovideo.ru/");
        const origin = `${targetUrl.protocol}//${targetUrl.host}`;
        const baseUrl = urlParam.substring(0, urlParam.lastIndexOf("/") + 1);

        const toProxy = (raw: string): string => {
          const abs = raw.startsWith("http")
            ? raw
            : raw.startsWith("/")
              ? origin + raw
              : baseUrl + raw;
          return `/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
        };

        const rewritten = body
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
                return `URI="${toProxy(uri)}"`;
              });
            }
            if (trimmed.startsWith("#")) return line;
            return toProxy(trimmed);
          })
          .join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.removeHeader("Content-Length");
        res.send(rewritten);
        req.log.info({ status: 200, kind: "playlist" }, "proxy playlist (rewritten)");
      } else {
        const total = full.length;
        const rangeHeader = req.headers["range"] as string | undefined;
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
