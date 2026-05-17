/**
 * weneverbeenfree.com / myvidplay.com ("Byse Frontend") extractor.
 *
 * These CDNs use fully obfuscated JavaScript that computes the HLS URL at
 * runtime — there is no accessible HTTP API we can call directly:
 *   - The getSources endpoints (MegaCloud-style) do not exist on these hosts.
 *   - The heartbeat endpoint requires a signed `fileId` that the browser JS
 *     computes internally and cannot be replicated without executing the JS.
 *
 * Solution: launch headless Chromium via Playwright, load the embed page, and
 * intercept the m3u8 network request that the page makes.
 */
import { logger } from "../../logger.js";
import { extractViaPlaywright } from "./playwright-extractor.js";
import type { StreamSource } from "../types.js";

export async function extractWeneverbeenfree(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info(
    { embedUrl: embedUrl.slice(0, 90) },
    "[WNBF] using Playwright headless browser extractor (Byse CDN)"
  );
  return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
}

export function isWeneverbeenfreeHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host.includes("weneverbeenfree") ||
      host.includes("wnbf") ||
      host.includes("myvidplay") ||
      host.includes("animefever")
    );
  } catch {
    return false;
  }
}
