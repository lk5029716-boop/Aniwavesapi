/**
 * Provider router — dispatches embed URLs to the correct extractor
 * based on server name or embed host.
 */
import { logger } from "../../logger.js";
import { extractVidplay, isVidplayHost } from "./vidplay.js";
import { extractByfms, isByfmsHost } from "./byfms.js";
import { extractDghg, isDghgHost } from "./dghg.js";
import type { StreamSource } from "../types.js";

export async function extractStream(
  embedUrl: string,
  serverName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const lowerName = serverName.toLowerCase();

  logger.info(
    { embedUrl: embedUrl.slice(0, 90), serverName },
    "dispatching to provider extractor"
  );

  // ── DGHG (PlayMogo / DoodStream) ──────────────────────────────────────────
  if (
    isDghgHost(embedUrl) ||
    lowerName.includes("dghg") ||
    lowerName.includes("playmogo") ||
    lowerName.includes("dood")
  ) {
    logger.info({ serverName }, "routing to DGHG extractor");
    return extractDghg(embedUrl, skipData);
  }

  // ── BYFMS (WeneverBeenFree) ───────────────────────────────────────────────
  if (
    isByfmsHost(embedUrl) ||
    lowerName.includes("byfms") ||
    lowerName.includes("weneverbeenfree")
  ) {
    logger.info({ serverName }, "routing to BYFMS extractor");
    return extractByfms(embedUrl, skipData);
  }

  // ── Vidplay ───────────────────────────────────────────────────────────────
  if (
    isVidplayHost(embedUrl) ||
    lowerName.includes("vidplay") ||
    lowerName.includes("vidcloud")
  ) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }

  // ── Unknown — try all extractors ──────────────────────────────────────────
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 90) },
    "unknown provider — trying all extractors"
  );

  const attempts = [
    () => extractDghg(embedUrl, skipData),
    () => extractVidplay(embedUrl),
    () => extractByfms(embedUrl, skipData),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result?.m3u8) return result;
    } catch { /* try next */ }
  }

  logger.error({ serverName, embedUrl: embedUrl.slice(0, 90) }, "all extractors failed");
  return null;
}
