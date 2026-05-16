/**
 * Vidplay extractor.
 *
 * Pipeline:
 * 1. Fetch embed page → extract source ID from inline JS
 * 2. GET /futoken → build token string
 * 3. VRF-encrypt the source ID (RC4)
 * 4. GET /mediainfo/{encodedId}?{token} → AES-encrypted JSON
 * 5. Decrypt → parse sources array → return m3u8
 */
import axios from "axios";
import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import { logger } from "../../logger.js";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

const FALLBACK_KEYS: number[][] = [[8, 0], [6, 2], [1, 5]];

async function fetchVidplayKeys(): Promise<number[][]> {
  try {
    const resp = await axios.get(
      "https://raw.githubusercontent.com/consumet/consumet.ts/master/src/extractors/vidplay.ts",
      { timeout: 5000 }
    );
    const text = resp.data as string;
    const match = text.match(/const\s+keys\s*=\s*(\[\[.*?\]\])/s);
    if (match) {
      const parsed = JSON.parse(match[1]) as number[][];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    logger.warn("could not fetch live vidplay keys, using fallback");
  }
  return FALLBACK_KEYS;
}

function vrfEncrypt(id: string, keys: number[][]): string {
  let result = id;
  for (const [key] of keys) {
    const wordArray = CryptoJS.enc.Utf8.parse(result);
    const encrypted = CryptoJS.RC4.encrypt(
      wordArray,
      CryptoJS.enc.Utf8.parse(String(key))
    );
    result = encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  }
  return encodeURIComponent(result.replace(/\//g, "_").replace(/\+/g, "-"));
}

function buildFutoken(keys: number[][], id: string): string {
  const parts: string[] = [`k=${keys.map((k) => k[0]).join(",")}`];
  for (let i = 0; i < keys.length; i++) {
    const [start, offset] = keys[i]!;
    const slice = id.slice(start, start + offset) || String(start);
    parts.push(slice);
  }
  return parts.join(",");
}

function aesDecrypt(ciphertext: string, key: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export async function extractVidplay(
  embedUrl: string
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  // Stage 1: Fetch embed page
  let embedHtml: string;
  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
        Referer: "https://aniwaves.ru/",
      },
    });
    embedHtml = resp.data as string;
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[Vidplay] Stage 1 FAILED");
    return null;
  }

  const $ = cheerio.load(embedHtml);
  const scriptContent = $("script:not([src])")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .join("\n");

  // Extract source ID
  let rawId: string | null = null;
  const idPatterns = [
    /getSources\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/,
    /var\s+id\s*=\s*['"]([^'"]+)['"]/,
    /["']id["']\s*:\s*["']([^'"]+)["']/,
    /\.getSources\s*\(\s*['"]([^'"]+)['"]/,
  ];
  for (const pat of idPatterns) {
    const m = scriptContent.match(pat);
    if (m) { rawId = m[1] ?? null; break; }
  }

  if (!rawId) {
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    rawId = pathParts[pathParts.length - 1] ?? null;
  }

  if (!rawId) {
    logger.error("[Vidplay] no source ID found");
    return null;
  }

  // Stage 2: Build token
  const keys = await fetchVidplayKeys();
  const token = buildFutoken(keys, rawId);
  const encodedId = vrfEncrypt(rawId, keys);

  // Stage 3: Request mediainfo
  const mediaInfoUrl = `https://${host}/mediainfo/${encodedId}`;

  let rawBody: string;
  try {
    const resp = await axios.get(mediaInfoUrl, {
      params: { t: token },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
    });
    rawBody = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[Vidplay] Stage 3 FAILED");
    return null;
  }

  // Stage 4: Parse response
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    parsed = { encrypted: true, sources: rawBody };
  }

  // Stage 5: Decrypt if needed
  let sourcesData: unknown = parsed["sources"];
  const isEncrypted =
    parsed["encrypted"] === true || typeof parsed["sources"] === "string";

  if (isEncrypted && typeof sourcesData === "string") {
    const decryptionKeys = [
      "9Y6I6HiQOqjDUlbAEWtFhg==",
      "WXrUARXb1aDLaZjI",
      "4wZuP5YkT1a4wZuP",
      "LXgbdW5rQ3VzdG9t",
    ];

    let decrypted: string | null = null;
    for (const dkey of decryptionKeys) {
      try {
        const result = aesDecrypt(sourcesData, dkey);
        if (result && result.startsWith("[")) {
          decrypted = result;
          break;
        }
      } catch { /* try next */ }
    }

    if (!decrypted) {
      try {
        const keyBytes = CryptoJS.MD5(rawId).toString();
        const result = aesDecrypt(sourcesData, keyBytes);
        if (result && result.length > 5) decrypted = result;
      } catch { /* ignore */ }
    }

    if (!decrypted) {
      logger.error("[Vidplay] all decryption attempts failed");
      return null;
    }

    try {
      sourcesData = JSON.parse(decrypted);
    } catch {
      logger.error("[Vidplay] decrypted payload is not valid JSON");
      return null;
    }
  }

  // Stage 6: Extract m3u8
  const sourcesArr = Array.isArray(sourcesData)
    ? sourcesData
    : Array.isArray(parsed["sources"])
      ? (parsed["sources"] as unknown[])
      : [];

  if (sourcesArr.length === 0) {
    logger.error("[Vidplay] empty source array");
    return null;
  }

  const tracksRaw = (parsed["tracks"] ?? parsed["subtitles"] ?? []) as Array<{
    file?: string; src?: string; label?: string; kind?: string;
  }>;

  const subtitles: Subtitle[] = tracksRaw
    .filter((t) => t.kind !== "thumbnails")
    .map((t) => ({
      lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
      label: t.label ?? "Unknown",
      url: t.file ?? t.src ?? "",
    }))
    .filter((s) => s.url);

  const thumbnailTrack = tracksRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;

  const intro = (parsed["intro"] as SkipTime) ?? null;
  const outro = (parsed["outro"] as SkipTime) ?? null;

  interface SourceEntry { file?: string; url?: string; src?: string; }

  const m3u8Source = (sourcesArr as SourceEntry[]).find((s) =>
    (s.file ?? s.url ?? s.src ?? "").toLowerCase().includes(".m3u8")
  );
  const anySource = (sourcesArr as SourceEntry[])[0];

  const m3u8 =
    m3u8Source?.file ?? m3u8Source?.url ?? m3u8Source?.src ??
    anySource?.file ?? anySource?.url ?? anySource?.src ?? null;

  if (!m3u8) {
    logger.error("[Vidplay] no m3u8 URL found");
    return null;
  }

  return {
    type: "direct",
    provider: "vidplay",
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro,
  };
}

export function isVidplayHost(embedUrl: string): boolean {
  try {
    const host = new URL(embedUrl).hostname;
    return (
      host.includes("vidplay") ||
      host.includes("vidcloud") ||
      host.includes("mcloud") ||
      host.includes("goload") ||
      host.includes("vidstreaming")
    );
  } catch {
    return false;
  }
}
