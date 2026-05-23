/**
 * DGHG / PlayMogo / DoodStream provider extractor v4.
 *
 * Cloudflare Turnstile bypass strategy:
 * Since Turnstile blocks datacenter IPs (Render, GCS, etc.), we use a Cloudflare
 * Worker as a proxy. The Worker fetches the embed page from Cloudflare's IP
 * (which gets 200 instead of 403), injects a JavaScript capture script, and
 * serves the page to the CLIENT's browser.
 *
 * The client's browser (residential IP) can solve Turnstile naturally. The
 * injected script captures the pass_md5 URL and posts it back to the Worker.
 * The client then polls the Worker for the result and constructs the m3u8 URL.
 *
 * Flow:
 * 1. Client requests /api/stream?server=dghg
 * 2. Server calls Worker to create a proxy session
 * 3. Server returns {type: "dghg_proxy", url: workerUrl, id: videoId, host: host}
 * 4. Client opens workerUrl in browser/iframe
 * 5. User's browser solves Turnstile, clicks play
 * 6. Injected JS captures pass_md5 → posts to Worker /__dghg_collect
 * 7. Client polls Worker /__dghg_result?id=xxx for pass_md5
 * 8. Client fetches pass_md5 value from playmogo to get CDN URL
 * 9. Client constructs m3u8 URL and plays it
 */

import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

// Cloudflare Worker URL for DGHG proxy
const DGHG_PROXY_WORKER = process.env.DGHG_PROXY_WORKER_URL || "https://dghg-proxy.lk5029716.workers.dev";

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] },
  proxyUrl?: string
): Promise<StreamSource | null | { _dghgProxy: { url: string; id: string; host: string; resultEndpoint: string } }> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const videoId = urlObj.pathname.split("/").pop() || "";

  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction v4 (Worker proxy)");

  // Use the Worker proxy URL if provided, otherwise use env var
  const workerBase = (proxyUrl || DGHG_PROXY_WORKER).replace(/\/$/, "");

  // Return the proxy info for client-side Turnstile solving
  const proxyPageUrl = `${workerBase}/?id=${encodeURIComponent(videoId)}&host=${encodeURIComponent(host)}`;
  const resultEndpoint = `${workerBase}/__dghg_result?id=${encodeURIComponent(videoId)}`;
  const playerUrl = `/api/player/dghg?id=${encodeURIComponent(videoId)}&host=${encodeURIComponent(host)}`;

  logger.info({ proxyPageUrl: proxyPageUrl.slice(0, 120) }, "[DGHG] returning proxy URL for client-side Turnstile solving");

  // Return a special object that the route handler will recognize
  return {
    _dghgProxy: {
      url: proxyPageUrl,
      player_url: playerUrl,
      id: videoId,
      host,
      resultEndpoint,
    },
  } as unknown as StreamSource;
}

export { isPlaymogoHost };
