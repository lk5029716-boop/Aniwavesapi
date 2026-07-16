/**
 * weneverbeenfree.com / myvidplay.com / Byse CDN ("BYFMS") extractor.
 *
 * Aniwaves.ru migrated BYFMS off the old `POST /embed/heartbeat` AES-GCM
 * endpoint (which is now dead: `{"error":"invalid payload"}`) to a
 * proof-of-work-gated `POST /embed/playback` flow:
 *
 *   1. POST /api/videos/{code}/captcha            -> { pow_nonce, pow_difficulty, pow_token }
 *   2. Mine sha256(`${pow_nonce}:${s}`) until it has >= pow_difficulty
 *      leading-zero BITS (the exact `gr`/`wr` algorithm from the site bundle).
 *   3. POST /api/videos/{code}/captcha/verify     -> { status:"ok", token }
 *   4. POST /api/videos/{code}/embed/playback
 *        Header: X-Captcha-Token: <token>
 *        Origin: https://aniwaves.ru   (domain whitelist — required)
 *        Body:   { fingerprint: { token } }
 *      -> { playback: { algorithm:"AES-256-GCM", iv, payload, key_parts[], version } }
 *   5. Decrypt `payload` (AES-256-GCM) with the key derived from `key_parts`
 *      (ks(ws(playback))) using WebCrypto, exactly like the site's `En()`.
 *
 * This is a pure-Node implementation — no headless browser required.
 * Verified end-to-end against the live Byse CDN.
 */
import { logger } from "../../logger.js";
import https from "https";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ANIWAVES_REFERER = "https://aniwaves.ru/";
const ANIWAVES_ORIGIN = "https://aniwaves.ru";

// ── PoW primitives (verbatim from the site's pow bundle) ──────────────────────
const BE = 512, DR = 2, LR = 2654435761, HR = 2246822519;
const rotl = (t: number, e: number) => (t << e | t >>> 32 - e) >>> 0;
const mul32 = (t: number, e: number) => Math.imul(t, e) >>> 0;

function ye(t: Uint32Array) {
  t[0] = t[0] + t[1] >>> 0;
  t[3] = rotl(t[3] ^ t[0], 16);
  t[2] = t[2] + t[3] >>> 0;
  t[1] = rotl(t[1] ^ t[2], 12);
  t[0] = t[0] + t[1] >>> 0;
  t[3] = rotl(t[3] ^ t[0], 8);
  t[2] = t[2] + t[3] >>> 0;
  t[1] = rotl(t[1] ^ t[2], 7);
}

/** Custom 128-bit hash from the site bundle (NOT standard SHA-256). */
function gr(t: Uint8Array): Uint32Array {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < t.length; i++) {
    e[0] = e[0] + t[i] >>> 0;
    e[0] = rotl(e[0], 7);
    ye(e);
  }
  for (let i = 0; i < 8; i++) ye(e);
  const r = new Uint32Array(BE);
  for (let i = 0; i < BE; i++) {
    ye(e);
    r[i] = (e[0] ^ e[2]) >>> 0;
  }
  for (let i = 0; i < DR; i++)
    for (let s = 0; s < BE; s++) {
      const a = r[s] & (BE - 1);
      let c = r[s] + r[a] >>> 0;
      c = rotl(c, 13);
      c = (c ^ mul32(r[(s + 1) & (BE - 1)], LR)) >>> 0;
      r[s] = c;
      e[0] = (e[0] ^ c) >>> 0;
      ye(e);
    }
  const n = new Uint32Array(8), o = BE / 8;
  for (let i = 0; i < 8; i++) {
    ye(e);
    let s = e[0];
    const a = i * o;
    for (let c = 0; c < o; c++) {
      const d = r[a + c];
      s = s + d >>> 0;
      s = rotl(s, 5);
      s = (s ^ mul32(d, HR)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}

function yr(str: string): Uint8Array {
  const e = new Uint8Array(str.length);
  for (let r = 0; r < str.length; r++) e[r] = str.charCodeAt(r) & 255;
  return e;
}

/** Count leading zero BITS across the uint32 words. */
function wr(t: Uint32Array): number {
  let e = 0;
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    if (n === 0) { e += 32; continue; }
    return e + Math.clz32(n);
  }
  return e;
}

function minePoW(nonce: string, difficulty: number, timeoutMs = 20000): string | null {
  const start = Date.now();
  let s = 0;
  while (Date.now() - start < timeoutMs) {
    if (wr(gr(yr(`${nonce}:${s}`))) >= difficulty) return String(s);
    s++;
  }
  return null;
}

// ── Key derivation (verbatim from the site bundle) ────────────────────────────
function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const rem = pad.length % 4;
  const p = rem ? pad + "=".repeat(4 - rem) : pad;
  return Uint8Array.from(Buffer.from(p, "base64"));
}

function Qa(): Record<string, [number, number]> {
  const e: Record<string, [number, number]> = {};
  for (let n = 1; n <= 20; n += 1) {
    const o = n ^ 0, a = 31 - n ^ 0;
    e[String(n)] = [o, a];
  }
  return e;
}

function Ea(version: unknown, total: number): [number, number] {
  const r = typeof version === "string" ? version.trim() : "";
  const o = Qa()[r];
  if (!o) return [0, 0];
  const [a, i] = o;
  return a < 1 || i < 1 || a > total || i > total ? [0, 0] : [a, i];
}

function ws(playback: { key_parts?: string[]; version?: string }): string[] {
  const t = Array.isArray(playback.key_parts) ? playback.key_parts : [];
  const [a, i] = Ea(playback.version, t.length);
  if (a === 0 && i === 0) return t;
  const n = [a, i]
    .map((o) => Number(o))
    .filter((o) => Number.isInteger(o) && o >= 1 && o <= t.length)
    .map((o) => t[o - 1])
    .filter((o) => typeof o === "string" && o.length > 0);
  return n.length > 0 ? n : t;
}

function ks(parts: string[]): Uint8Array {
  const t = parts.filter((a) => typeof a === "string" && a.length > 0).map(b64urlToBytes);
  const r = t.reduce((a, i) => a + i.length, 0);
  const n = new Uint8Array(r);
  let o = 0;
  for (const a of t) { n.set(a, o); o += a.length; }
  return n;
}

/** Decrypt the playback payload exactly like the site's `En()` (WebCrypto path). */
async function decryptPlayback(playback: {
  iv: string;
  payload: string;
  key_parts?: string[];
  version?: string;
}): Promise<string | null> {
  const key = ks(ws(playback));
  const iv = b64urlToBytes(playback.iv);
  const ct = b64urlToBytes(playback.payload);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const cryptoKey = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
    return new TextDecoder().decode(plain);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "[WNBF] AES-GCM decrypt failed");
    return null;
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function postJson(
  host: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: host,
        path,
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          "Referer": ANIWAVES_REFERER,
          "Origin": ANIWAVES_ORIGIN,
          "Accept": "application/json",
          ...headers,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res: any) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => {
          let json: any;
          try { json = JSON.parse(d); } catch { json = d; }
          resolve({ status: res.statusCode ?? 0, body: json });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export async function extractWeneverbeenfree(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  let videoId: string | null = null;
  let host: string | null = null;
  try {
    const u = new URL(embedUrl);
    host = u.hostname;
    const m = u.pathname.match(/\/e\/([A-Za-z0-9_-]+)/);
    if (m) videoId = m[1];
  } catch {
    logger.error({ embedUrl }, "[WNBF] invalid embed URL");
    return null;
  }
  if (!videoId || !host) {
    logger.error({ embedUrl }, "[WNBF] could not parse video id from embed URL");
    return null;
  }

  logger.info({ videoId, host }, "[WNBF] starting PoW-gated extraction");

  try {
    // 1. captcha challenge
    const c = await postJson(host, `/api/videos/${videoId}/captcha`, {});
    if (c.status !== 200 || !c.body?.pow_nonce) {
      logger.error({ status: c.status, body: JSON.stringify(c.body).slice(0, 120) }, "[WNBF] captcha challenge failed");
      return null;
    }
    const { pow_nonce, pow_difficulty, pow_token } = c.body;

    // 2. mine PoW
    const solution = minePoW(pow_nonce, pow_difficulty);
    if (!solution) {
      logger.error("[WNBF] PoW mining timed out");
      return null;
    }

    // 3. verify
    const v = await postJson(host, `/api/videos/${videoId}/captcha/verify`, {
      pow_token,
      solution,
    });
    if (v.status !== 200 || v.body?.status !== "ok" || !v.body?.token) {
      logger.error({ status: v.status, body: JSON.stringify(v.body).slice(0, 120) }, "[WNBF] captcha verify failed");
      return null;
    }
    const capToken = v.body.token;

    // 4. playback (needs X-Captcha-Token header + aniwaves Origin + fingerprint body)
    const p = await postJson(
      host,
      `/api/videos/${videoId}/embed/playback`,
      { fingerprint: { token: capToken } },
      { "X-Captcha-Token": capToken }
    );
    if (p.status !== 200 || !p.body?.playback) {
      logger.error({ status: p.status, body: JSON.stringify(p.body).slice(0, 160) }, "[WNBF] playback request failed");
      return null;
    }

    // 5. decrypt
    const decrypted = await decryptPlayback(p.body.playback);
    if (!decrypted) {
      logger.error("[WNBF] could not decrypt playback payload");
      return null;
    }
    const parsed = JSON.parse(decrypted);
    const sources: any[] = Array.isArray(parsed?.sources) ? parsed.sources : [];
    const master =
      sources.find((s) => s?.mime_type?.includes("mpegurl") && s?.url?.includes("master"))?.url ??
      sources.find((s) => s?.mime_type?.includes("mpegurl"))?.url ??
      sources[0]?.url ??
      null;

    if (!master) {
      logger.error("[WNBF] no m3u8 url in decrypted payload");
      return null;
    }

    logger.info({ m3u8: master.slice(0, 130) }, "[WNBF] extraction SUCCESS");

    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }

    const subtitles: Subtitle[] = [];

    return {
      type: "direct",
      provider: "byfms",
      m3u8: master,
      subtitles,
      thumbnails: parsed?.poster_url ?? null,
      intro,
      outro,
    };
  } catch (err) {
    logger.error({ error: (err as Error).message }, "[WNBF] fatal error");
    return null;
  }
}

export function isWeneverbeenfreeHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return (
      h.includes("weneverbeenfree") ||
      h.includes("wnbf") ||
      h.includes("myvidplay") ||
      h.includes("animefever") ||
      h.includes("owphbf") ||
      h.includes("sprintcdn")
    );
  } catch {
    return false;
  }
}
