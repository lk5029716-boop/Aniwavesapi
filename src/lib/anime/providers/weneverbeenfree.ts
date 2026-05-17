/**
 * weneverbeenfree.com provider extractor (BYFMS server)
 *
 * The site is protected by Cloudflare Turnstile. The flow discovered via
 * reverse engineering:
 *   1. GET /e/{videoId}  → page HTML + CF cookies
 *   2. POST /api/videos/{videoId}/embed/heartbeat  → AES-GCM encrypted payload
 *   3. Decrypt payload with key from videoPagesBundle JS
 *
 * Direct HTTP extraction fails because:
 *   a) Cloudflare Turnstile challenges cannot be solved via plain HTTP requests.
 *   b) The heartbeat POST requires a browser-generated fingerprint token.
 *
 * Strategy:
 *   - Attempt direct HTTP heartbeat (works if CF cookies are still warm from
 *     a recent browser visit, unlikely in server context)
 *   - Fall through to Playwright headless extraction which can solve Turnstile
 *     challenges and run the page JS to obtain the m3u8.
 */
import axios from "axios";
import { logger } from "../../logger.js";
import { extractViaPlaywright } from "./playwright-extractor.js";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

interface HeartbeatResponse {
  iv?: string;
  payload?: string;
  error?: string;
  sources?: string | Array<{ file?: string; url?: string }>;
  tracks?: Array<{ file?: string; kind?: string; label?: string }>;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

async function tryDecryptAesGcm(
  ivBase64: string,
  cipherBase64: string,
  keyHex: string
): Promise<string | null> {
  try {
    const { webcrypto } = await import("node:crypto");
    const subtle = webcrypto.subtle;

    const keyBytes = Buffer.from(keyHex, "hex");
    const iv = Buffer.from(ivBase64, "base64");
    const ciphertext = Buffer.from(cipherBase64, "base64");

    const cryptoKey = await subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

const KNOWN_KEYS_HEX: string[] = [];

export async function extractWeneverbeenfree(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const videoId = urlObj.pathname.split("/").filter(Boolean).pop();

  if (!videoId) {
    logger.error({ embedUrl }, "[WNBF S1] FAILED — no videoId in embed URL");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  logger.info(
    { embedUrl: embedUrl.slice(0, 80), host, videoId },
    "[WNBF S1] starting weneverbeenfree extraction"
  );

  const commonHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, */*",
    Origin: `https://${host}`,
    Referer: `https://${host}/e/${videoId}`,
  };

  // ── S2: Fetch embed page for CF cookies ──────────────────────────────────
  logger.info({ videoId }, "[WNBF S2] fetching embed page for CF cookies");

  let cfCookies = "";
  try {
    const pageResp = await axios.get(embedUrl, {
      timeout: 12000,
      headers: {
        ...commonHeaders,
        Accept: "text/html,*/*",
        Referer: "https://aniwaves.ru/",
      },
      withCredentials: true,
    });
    const setCookie = pageResp.headers["set-cookie"];
    if (Array.isArray(setCookie)) {
      cfCookies = setCookie
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    logger.debug(
      { status: pageResp.status, cookieCount: (setCookie ?? []).length },
      "[WNBF S2] embed page fetched"
    );
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "[WNBF S2] embed page fetch failed");
  }

  // ── S3: POST heartbeat ────────────────────────────────────────────────────
  logger.info({ videoId }, "[WNBF S3] posting heartbeat to get encrypted payload");

  const heartbeatUrl = `https://${host}/api/videos/${videoId}/embed/heartbeat`;
  let heartbeatData: HeartbeatResponse | null = null;

  try {
    const resp = await axios.post<HeartbeatResponse>(
      heartbeatUrl,
      { fileId: videoId },
      {
        timeout: 12000,
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          ...(cfCookies ? { Cookie: cfCookies } : {}),
        },
      }
    );
    heartbeatData = resp.data;
    logger.debug(
      {
        status: resp.status,
        hasIv: !!heartbeatData?.iv,
        hasPayload: !!heartbeatData?.payload,
        hasSources: !!heartbeatData?.sources,
        error: heartbeatData?.error,
      },
      "[WNBF S3] heartbeat response"
    );
  } catch (err) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logger.warn(
      {
        heartbeatUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200),
      },
      "[WNBF S3] heartbeat request failed — falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  if (heartbeatData?.error) {
    logger.warn(
      { error: heartbeatData.error },
      "[WNBF S3] heartbeat returned error — falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  if (heartbeatData?.sources) {
    logger.info("[WNBF S3] heartbeat returned unencrypted sources — skipping decrypt");
    const rawSrc = heartbeatData.sources;
    const m3u8 =
      typeof rawSrc === "string"
        ? rawSrc
        : (rawSrc as Array<{ file?: string; url?: string }>)[0]?.file ??
          (rawSrc as Array<{ file?: string; url?: string }>)[0]?.url ??
          null;
    return buildResult("weneverbeenfree", m3u8, heartbeatData, skipData);
  }

  const { iv, payload } = heartbeatData ?? {};
  if (!iv || !payload) {
    logger.warn("[WNBF S4] no iv/payload in heartbeat — falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  logger.info("[WNBF S4] attempting AES-GCM decryption with known keys");

  let decryptedText: string | null = null;
  for (const keyHex of KNOWN_KEYS_HEX) {
    decryptedText = await tryDecryptAesGcm(iv, payload, keyHex);
    if (decryptedText) {
      logger.debug(
        { keyHex: keyHex.slice(0, 8) + "..." },
        "[WNBF S4] AES-GCM decryption succeeded"
      );
      break;
    }
  }

  if (!decryptedText) {
    logger.warn("[WNBF S4] all known keys failed — falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  logger.info("[WNBF S5] parsing decrypted payload");

  let parsed: HeartbeatResponse;
  try {
    parsed = JSON.parse(decryptedText) as HeartbeatResponse;
  } catch {
    logger.error(
      { snippet: decryptedText.slice(0, 100) },
      "[WNBF S5] decrypted payload is not valid JSON — falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  const rawSrc = parsed.sources;
  const m3u8 =
    typeof rawSrc === "string"
      ? rawSrc
      : (rawSrc as Array<{ file?: string; url?: string }>)?.[0]?.file ??
        (rawSrc as Array<{ file?: string; url?: string }>)?.[0]?.url ??
        null;

  if (!m3u8) {
    logger.warn("[WNBF S5] no m3u8 in decrypted payload — falling back to Playwright");
    return extractViaPlaywright(embedUrl, "weneverbeenfree", skipData);
  }

  return buildResult("weneverbeenfree", m3u8, parsed, skipData);
}

function buildResult(
  provider: string,
  m3u8: string | null,
  data: HeartbeatResponse,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): StreamSource {
  const tracksRaw = data.tracks ?? [];
  const subtitles: Subtitle[] = tracksRaw
    .filter(
      (t) => t.kind !== "thumbnails" && t.kind !== "preview" && (t.file ?? "").length > 0
    )
    .map((t) => ({
      lang: (t.label ?? "unknown").toLowerCase().replace(/\s+/g, "-"),
      label: t.label ?? "Unknown",
      url: t.file ?? "",
    }));

  const thumbnailTrack = tracksRaw.find(
    (t) => t.kind === "thumbnails" || t.kind === "preview"
  );
  const thumbnails = thumbnailTrack?.file ?? null;

  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;
  if (data.intro && (data.intro.start !== 0 || data.intro.end !== 0)) {
    intro = { start: data.intro.start, end: data.intro.end };
  } else if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (data.outro && (data.outro.start !== 0 || data.outro.end !== 0)) {
    outro = { start: data.outro.start, end: data.outro.end };
  } else if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  logger.info(
    { m3u8: (m3u8 ?? "null").slice(0, 80), subtitles: subtitles.length, intro, outro },
    "[WNBF S7] extraction complete"
  );

  return {
    type: "direct",
    provider,
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro,
  };
}

export function isWeneverbeenfreeHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("weneverbeenfree") || host.includes("wnbf");
  } catch {
    return false;
  }
}
