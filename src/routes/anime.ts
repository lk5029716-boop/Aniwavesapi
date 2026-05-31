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

  const stream = await extractStream(sourcesResult.url, "direct", {
    intro: sourcesResult.skip_data?.intro,
    outro: sourcesResult.skip_data?.outro,
  }, proxyUrl);

  if (stream?.m3u8) {
    res.json({ ...stream, _server: "direct" });
    return;
  }

res.status(502).json({ error: "Stream extraction failed from serverId" });
});

/**
 * GET /api/test-dghg — debug DGHG extraction timing from Render
 */
router.get("/test-dghg", async (_req, res): Promise<void> => {
  const logs: string[] = [];
  const t0 = Date.now();
  const log = (msg: string) => { logs.push(`[${Date.now() - t0}ms] ${msg}`); };

  try {
    log("Starting DGHG debug test");

    // Step 1: Simple fetch to playmogo
    log("Testing plain fetch to playmogo...");
    try {
      const r = await fetch("https://playmogo.com/e/cn3fn0zskodx", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: "https://aniwaves.ru/",
        },
        signal: AbortSignal.timeout(8000),
      });
      log(`Plain fetch: HTTP ${r.status}`);
    } catch (e) {
      log(`Plain fetch error: ${(e as Error).message}`);
    }

    // Step 2: Python scraper test
    log("Testing Python scraper...");
    try {
      const { execSync } = await import("child_process");
      const pyResult = execSync(
        'python3 -c "from curl_cffi import requests; print(\\"curl_cffi OK\\")"',
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      log(`Python: ${pyResult}`);
    } catch (e) {
      log(`Python error: ${(e as Error).message}`);
    }

    // Step 3: curl_cffi direct test
    log("Testing curl_cffi direct extraction...");
    try {
      const { execSync } = await import("child_process");
      const result = execSync(
        'python3 -c "\nfrom curl_cffi import requests\ns = requests.Session(impersonate=\\"chrome124\\")\nr = s.get(\\"https://playmogo.com/e/cn3fn0zskodx\\", timeout=8)\nprint(f\\\"Status: {r.status_code}\\\")\nprint(r.text[:200])\n"',
        { encoding: "utf8", timeout: 15000 }
      ).trim();
      log(`curl_cffi result:\n${result}`);
    } catch (e) {
      log(`curl_cffi error: ${(e as Error).message}`);
    }

    log("Done");
    res.json({ logs, elapsed: Date.now() - t0 });
  } catch (e) {
    log(`Fatal: ${(e as Error).message}`);
    res.json({ logs, elapsed: Date.now() - t0, error: (e as Error).message });
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

export default router;
