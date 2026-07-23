/**
 * Optional Cloudflare-Worker proxy support.
 *
 * aniwaves.ru + its CDN hosts (play.echovideo.ru, myvidplay.com, playmogo.com,
 * ...) now sit behind Cloudflare bot management. From a datacenter IP (e.g. a
 * Render/Hetzner box) requests can intermittently get challenged (403/503).
 *
 * Fix: deploy cf_worker_proxy.js as a Cloudflare Worker and set
 *   ANIWAVES_PROXY_URL=https://<your-worker>.workers.dev
 * (optionally append ?k=<PROXY_SECRET> if you locked the worker down).
 *
 * When the var is unset, maybeProxy() is a no-op and traffic goes direct — so
 * this is zero-risk on a normal/local setup.
 */
import { logger } from "../logger.js";

const PROXY_BASE = (process.env["ANIWAVES_PROXY_URL"] ?? "").trim();

/** Hosts that may need to be proxied (Cloudflare-fronted).
 *  NOTE: aniwaves.ru itself is reached fine from a datacenter IP (Render) for
 *  /ajax/* — only the PLAYER CDN hosts (playmogo/myvidplay) strip the token
 *  for datacenter IPs. Proxying aniwaves.ru through an HTTP proxy can get it
 *  challenged/blocked, so it is deliberately NOT in this list. The player
 *  hosts are extracted by dghg_http.py via DGHG_HTTP_PROXY instead. */
const PROXIED_HOSTS = [
  "echovideo.ru",
  "echovideo.to",
  "play.echovideo.ru",
  "myvidplay.com",
  "playmogo.com",
  "gn1r5n.org",
  "weneverbeenfree.com",
];

let warned = false;

export function proxyEnabled(): boolean {
  return PROXY_BASE.length > 0;
}

function shouldProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PROXIED_HOSTS.some(
      (h) => host === h || host.endsWith("." + h)
    );
  } catch {
    return false;
  }
}

/**
 * Return either the original URL (no proxy) or a worker-proxied URL.
 * The worker expects `?url=<encoded target>` and `&k=<secret>` (optional).
 */
export function maybeProxy(url: string): string {
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

/**
 * When proxied, the Worker injects its own Referer/Origin; strip ours so they
 * don't conflict. Keeps other headers (we still want X-Requested-With for ajax).
 */
export function proxyHeaders(
  headers: Record<string, string>
): Record<string, string> {
  if (!proxyEnabled()) return headers;
  const out = { ...headers };
  delete out["Referer"];
  delete out["Origin"];
  return out;
}
