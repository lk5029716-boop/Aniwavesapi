/**
 * DGHG / PlayMogo / DoodStream provider extractor.
 *
 * Flow:
 *   1. GET /e/{videoCode} → extract pass_md5 path and token from HTML
 *   2. GET /pass_md5/{path} → get CDN base URL
 *   3. Build final URL: {cdnUrl}?token={token}&expiry={timestamp}
 *
 * Uses curl with proxy support for Cloudflare/IP blocking bypass.
 */
import { execFileSync } from "child_process";
import axios from "axios";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

const DOOD_HOSTS = [
  "playmogo.com", "myvidplay.com", "doodstream.com", "dood.la",
  "dood.to", "dood.so", "dood.ws", "dood.pm", "dood.wf", "dood.re",
  "dood.yt", "dood.cx", "dood.sh", "dood.watch",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Proxy to use for DGHG requests (set via env var)
const PROXY_URL = process.env["DGHG_PROXY"] || null;

function isPlaymogoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DOOD_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function buildCurlArgs(url: string, referer: string): string[] {
  const args = [
    "-s", "-L",
    "-A", UA,
    "-H", "Accept: text/html,*/*",
    "-H", `Referer: ${referer}`,
    "--max-redirs", "5",
    "--connect-timeout", "15",
    "--max-time", "30",
  ];
  if (PROXY_URL) {
    args.push("-x", PROXY_URL);
  }
  args.push("-w", "\n%{http_code}", url);
  return args;
}

function tryCurl(url: string, referer: string): { body: string; error: string | null } {
  try {
    const args = buildCurlArgs(url, referer);
    const result = execFileSync("curl", args, { encoding: "utf8", timeout: 35000 });
    const lines = result.trim().split("\n");
    const httpCode = lines[lines.length - 1];
    const body = lines.slice(0, -1).join("\n");

    if (httpCode !== "200") {
      return { body: body.slice(0, 200), error: `HTTP ${httpCode}` };
    }
    return { body, error: null };
  } catch (err) {
    return { body: "", error: (err as Error).message };
  }
}

async function tryAxios(url: string, referer: string): Promise<{ body: string; error: string | null }> {
  try {
    const config: Record<string, unknown> = {
      timeout: 15000,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,*/*",
        Referer: referer,
      },
      maxRedirects: 5,
    };
    if (PROXY_URL) {
      const proxyUrl = new URL(PROXY_URL);
      config["proxy"] = {
        host: proxyUrl.hostname,
        port: parseInt(proxyUrl.port || "8080"),
      };
    }
    const resp = await axios.get(url, config);
    return { body: resp.data as string, error: null };
  } catch (err) {
    const e = err as Error & { response?: { status: number } };
    return { body: "", error: `HTTP ${e.response?.status || '?'}: ${e.message}` };
  }
}

export async function extractDghg(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource & { _dghgDebug?: string }> {
  logger.info({ embedUrl: embedUrl.slice(0, 100), proxy: !!PROXY_URL }, "[DGHG] starting extraction");

  // Step 1: Fetch embed page
  let html: string = "";
  let step1Error: string | null = null;

  // Try curl first
  const curlResult = tryCurl(embedUrl, "https://aniwaves.ru/");
  if (!curlResult.error && curlResult.body) {
    html = curlResult.body;
  } else {
    // Try axios
    const axiosResult = await tryAxios(embedUrl, "https://aniwaves.ru/");
    if (!axiosResult.error && axiosResult.body) {
      html = axiosResult.body;
    } else {
      step1Error = `curl: ${curlResult.error}, axios: ${axiosResult.error}`;
    }
  }

  if (!html || step1Error) {
    logger.error({ error: step1Error }, "[DGHG] Step 1 FAILED");
    return {
      type: "direct", provider: "dghg", m3u8: null, subtitles: [],
      thumbnails: null, intro: null, outro: null,
      _dghgDebug: step1Error || "empty",
    };
  }

  // Step 2: Extract pass_md5 path
  let passMd5Path: string | null = null;
  const passMd5Match = html.match(/\$\.get\s*\(\s*['"]\/pass_md5\/([^'"]+)['"]\s*,/);
  if (passMd5Match) passMd5Path = passMd5Match[1];

  let token: string | null = null;
  if (passMd5Path) {
    const parts = passMd5Path.split("/");
    token = parts[parts.length - 1] || null;
  }
  if (!token) {
    const tokenMatch = html.match(/cookieIndex\s*=\s*['"]([^'"]+)['"]/);
    token = tokenMatch?.[1] ?? null;
  }

  if (!passMd5Path || !token) {
    return {
      type: "direct", provider: "dghg", m3u8: null, subtitles: [],
      thumbnails: null, intro: null, outro: null,
      _dghgDebug: `no pass_md5: passMd5=${!!passMd5Path}, token=${!!token}`,
    };
  }

  // Step 3: Call pass_md5
  const urlObj = new URL(embedUrl);
  const passMd5Url = `https://${urlObj.hostname}/pass_md5/${passMd5Path}`;

  let cdnBaseUrl: string = "";
  const curlPassMd5 = tryCurl(passMd5Url, embedUrl);
  if (!curlPassMd5.error && curlPassMd5.body && curlPassMd5.body.startsWith("http")) {
    cdnBaseUrl = curlPassMd5.body;
  } else {
    const axiosPassMd5 = await tryAxios(passMd5Url, embedUrl);
    if (!axiosPassMd5.error && axiosPassMd5.body && axiosPassMd5.body.startsWith("http")) {
      cdnBaseUrl = axiosPassMd5.body;
    } else {
      return {
        type: "direct", provider: "dghg", m3u8: null, subtitles: [],
        thumbnails: null, intro: null, outro: null,
        _dghgDebug: `pass_md5 failed: curl=${curlPassMd5.error}, axios=${axiosPassMd5.error}`,
      };
    }
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
