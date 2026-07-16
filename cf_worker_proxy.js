// Cloudflare Worker — transparent proxy for aniwaves + echovideo
// Deploy at dash.cloudflare.com, then call:
//   https://<your-worker>.workers.dev/?url=<encoded target url>
// Set PROXY_SECRET in Variables to lock it down.

const ALLOWED = [
  "aniwaves.ru",
  "play.echovideo.ru",
  "echovideo.ru",
  "echovideo.to",
  "playmogo.com",
  "myvidplay.com",
  "gn1r5n.org",
  "weneverbeenfree.com",
];

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const target = u.searchParams.get("url");
    const secret = u.searchParams.get("k");
    if (env.PROXY_SECRET && secret !== env.PROXY_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    if (!target) return new Response("missing ?url=", { status: 400 });

    let t;
    try { t = new URL(target); } catch { return new Response("bad url", {status:400}); }
    if (!ALLOWED.some(d => t.hostname === d || t.hostname.endsWith("." + d))) {
      return new Response("host not allowed", { status: 403 });
    }

    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    if (!headers.has("user-agent")) {
      headers.set("user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    }
    headers.set("referer", t.origin + "/");

    const upstream = await fetch(t.toString(), {
      method: req.method,
      headers,
      body: ["GET","HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "follow",
    });

    const out = new Headers(upstream.headers);
    out.set("access-control-allow-origin", "*");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}
