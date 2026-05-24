/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * These hosts use Cloudflare Turnstile which blocks all datacenter IPs.
 * We cannot extract server-side. Instead, return null and let the frontend
 * handle DGHG via a direct embed popup (user's browser = residential IP = Turnstile passes).
 */

import { logger } from "../../logger.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

export function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

export async function extractDghg(
  embedUrl: string,
  _skipData?: { intro?: [number, number]; outro?: [number, number] },
  _proxyUrl?: string | null
): Promise<null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] returning null — frontend will handle via direct embed");
  return null;
}
