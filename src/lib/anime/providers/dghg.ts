/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Flow:
 *   1. GET embed page → extract pass_md5 path + token
 *   2. GET /pass_md5/{path} → get CDN base URL
 *   3. Build final URL: {cdnUrl}?token={token}&expiry={timestamp}
 *
 * Uses curl because Cloudflare blocks axios/node-fetch TLS fingerprints.
 */
import { execSync } from "child_process";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function curlFetch(url: string, referer?: string): string {
  // Check if curl exists
  try {
    execSync("which curl", { encoding: "utf8" });
  } catch {
    logger.error("curl not found on system");
    return "";
  }

  const args = [
    "-s", "-L",
    "-A", UA,
    "-H", "Accept: text/html,*/*",
    "-H", `Referer: ${referer || "https://aniwaves.ru/"}`,
    "--max-redirs", "5",
    "--connect-timeout", "15",
    "--max-time", "30",
    url,
  ];
  try {
    const result = execSync("curl " + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" "), {
      encoding: "utf8",
      timeout: 35000,
    });
    return result.trim();
  } catch (err) {
    const e = err as Error & { stderr?: Buffer };
    logger.warn({
      url: url.slice(0, 80),
      error: e.message,
      stderr: e.stderr?.toString().slice(0, 200),
    }, "curl fetch failed");
    return "";
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100) }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page
  const html = curlFetch(embedUrl, "https://aniwaves.ru/");
  logger.debug({ htmlLen: html.length, htmlSnippet: html.slice(0, 200) }, "[DGHG] step 1 result");

  if (!html) {
    logger.error("[DGHG] Step 1 FAILED — empty response from embed page");
    return null;
  }

  // Step 2: Extract pass_md5 path
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) {
    passMd5Path = passMd5Match[1];
  }

  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }

  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }

  logger.debug(
    { passMd5Path: passMd5Path?.slice(0, 80), token },
    "[DGHG] extracted creds"
  );

  if (!passMd5Path) {
    logger.error({ htmlSnippet: html.slice(0, 500) }, "[DGHG] Step 2 FAILED — no pass_md5 path found");
    return null;
  }

  // Step 3: Call pass_md5
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;
  logger.debug({ passMd5Url: passMd5Url.slice(0, 100) }, "[DGHG] step 3 URL");

  const cdnBaseUrl = curlFetch(passMd5Url, embedUrl);
  logger.debug({ cdnBaseLen: cdnBaseUrl.length, cdnBaseSnippet: cdnBaseUrl.slice(0, 100) }, "[DGHG] step 3 result");

  if (!cdnBaseUrl || !cdnBaseUrl.startsWith("http")) {
    logger.error({ cdnBaseUrl: cdnBaseUrl.slice(0, 200) }, "[DGHG] Step 3 FAILED — no CDN URL");
    return null;
  }

  // Step 4: Build final URL
  const expiry = Date.now();
  const finalUrl = `${cdnBaseUrl}?token=${token}&expiry=${expiry}`;

  logger.info({ finalUrl: finalUrl.slice(0, 120) }, "[DGHG] extraction SUCCESS");

  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  return {
    type: "direct",
    provider: "dghg",
    m3u8: finalUrl,
    subtitles: [],
    thumbnails: null,
    intro,
    outro,
  };
}

export { isPlaymogoHost };
