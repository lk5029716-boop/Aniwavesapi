import { logger } from "../../logger.js";
import { extractVidplay, isVidplayHost } from "./vidplay.js";
import { extractMegacloud, isMegacloudHost } from "./megacloud.js";
import { extractEchovideo, isEchovideoHost } from "./echovideo.js";
import { extractWeneverbeenfree, isWeneverbeenfreeHost } from "./weneverbeenfree.js";
import { extractDghg, isPlaymogoHost } from "./dghg.js";
import type { StreamSource } from "../types.js";

/** Hosts that are Vidplay clones/mirrors */
const VIDPLAY_LIKE_HOSTS = [
  "vidplay.online",
  "vidplay.lol",
  "vidcloud.lol",
  "mcloud.bz",
  "vidstreaming.io",
  "goload.pro",
];

/** Hosts that use the MegaCloud getSources+decrypt pipeline */
const MEGACLOUD_LIKE_HOSTS = [
  "megacloud.tv",
  "rapid-cloud.co",
  "rabbitstream.net",
];

/** Hosts that use the WeneverBeenFree/myvidplay MegaCloud-style pipeline */
const WNBF_LIKE_HOSTS = [
  "weneverbeenfree.com",
  "myvidplay.com",   // DGHG server - same MegaCloud-style API
];

/** Hosts that use the Echovideo getSources pipeline */
const ECHOVIDEO_LIKE_HOSTS = [
  "play.echovideo.ru",
  "echovideo.ru",
];

function matchHost(url: string, hostList: string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return hostList.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

export async function extractStream(
  embedUrl: string,
  serverName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] },
  proxyUrl?: string | null
): Promise<StreamSource | null> {
  const lowerName = serverName.toLowerCase();

  logger.info(
    { embedUrl: embedUrl.slice(0, 90), serverName },
    "dispatching to provider extractor"
  );

  // ── Echovideo (aniwaves primary CDN) ────────────────────────────────────────
  if (
    matchHost(embedUrl, ECHOVIDEO_LIKE_HOSTS) ||
    isEchovideoHost(embedUrl)
  ) {
    logger.info({ serverName }, "routing to Echovideo extractor");
    return extractEchovideo(embedUrl, skipData);
  }

  // ── DGHG / PlayMogo / DoodStream (Turnstile-protected) ──────────────────────
  // These hosts block datacenter IPs. Route to client-side proxy via Cloudflare Worker.
  // Must come BEFORE the weneverbeenfree check since myvidplay.com is in WNBF_LIKE_HOSTS.
  if (
    lowerName.includes("dghg") ||
    isPlaymogoHost(embedUrl)
  ) {
    logger.info({ serverName, host: new URL(embedUrl).hostname }, "routing to DGHG client-side proxy extractor");
    return extractDghg(embedUrl, skipData, proxyUrl);
  }

  // ── WeneverBeenFree / myvidplay.com ─────────────────────────────────────────
  // BYFMS → weneverbeenfree.com, DGHG → myvidplay.com
  // Both use the MegaCloud-style getSources API with key-embedded AES encryption
  if (
    matchHost(embedUrl, WNBF_LIKE_HOSTS) ||
    isWeneverbeenfreeHost(embedUrl) ||
    lowerName.includes("byfms") ||
    lowerName.includes("dghg") ||
    lowerName.includes("weneverbeenfree")
  ) {
    logger.info({ serverName, host: new URL(embedUrl).hostname }, "routing to WeneverBeenFree/myvidplay extractor");
    return extractWeneverbeenfree(embedUrl, skipData);
  }

  // ── MegaCloud / RapidCloud / RabbitStream ────────────────────────────────────
  if (
    matchHost(embedUrl, MEGACLOUD_LIKE_HOSTS) ||
    isMegacloudHost(embedUrl) ||
    lowerName.includes("megacloud") ||
    lowerName.includes("rapidcloud") ||
    lowerName.includes("rabbitstream")
  ) {
    logger.info({ serverName }, "routing to MegaCloud extractor");
    return extractMegacloud(embedUrl);
  }

  // ── Vidplay and mirrors ──────────────────────────────────────────────────────
  if (
    matchHost(embedUrl, VIDPLAY_LIKE_HOSTS) ||
    isVidplayHost(embedUrl) ||
    lowerName.includes("vidplay") ||
    lowerName.includes("vidcloud")
  ) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }

  // ── Unknown host — heuristic fallback ────────────────────────────────────────
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 90) },
    "unknown provider host — running heuristic detection"
  );

  // Echovideo-style: path contains /embed-N/ and ends with a token
  if (/\/embed-\d+\/[A-Za-z0-9_-]{20,}/.test(embedUrl)) {
    logger.info({ serverName }, "heuristic: looks like Echovideo (embed-N path)");
    const echoResult = await extractEchovideo(embedUrl, skipData);
    if (echoResult?.m3u8) return echoResult;
  }

  // MegaCloud-style: path starts with /e/ and has a short alphanumeric ID
  if (/\/e\/[a-z0-9]{10,16}/.test(embedUrl)) {
    logger.info({ serverName }, "heuristic: looks like WeneverBeenFree/MegaCloud (/e/ path)");
    const wnbfResult = await extractWeneverbeenfree(embedUrl, skipData);
    if (wnbfResult?.m3u8) return wnbfResult;

    const megaResult = await extractMegacloud(embedUrl);
    if (megaResult?.m3u8) return megaResult;
  }

  // Last resort: try all extractors
  logger.warn({ serverName }, "trying all extractors in sequence as last resort");

  const attempts = [
    () => extractWeneverbeenfree(embedUrl, skipData),
    () => extractEchovideo(embedUrl, skipData),
    () => extractMegacloud(embedUrl),
    () => extractVidplay(embedUrl),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result?.m3u8) return result;
    } catch {}
  }

  logger.error({ serverName, embedUrl: embedUrl.slice(0, 90) }, "all extractors failed");
  return null;
}
