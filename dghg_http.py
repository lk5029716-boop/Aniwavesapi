#!/usr/bin/env python3
"""DGHG HTTP-only extraction (no browser, no Cloudflare JS challenge).

Cloudflare only challenges the *pretty* HTML document and TLS fingerprints
from undici/curl_cffi. Python's stdlib urllib (OpenSSL, HTTP/1.1) passes
the /e/<id>/ajax endpoint, which embeds the /pass_md5/<hash>/<token> URL.

KEY: playmogo.com / myvidplay.com *strip* the /pass_md5/ token for
datacenter IPs (Render gets a ~5.6KB token-less page -> "no-token").
The DoodStream network shares the SAME video id + CDN across its public
mirrors (d0000d.com, dood.to, ds2play.com, vidply.com, ...). Those
mirrors serve the full token page even from datacenter IPs, so we REWRITE
the host to d0000d.com and extract there. No proxy, no browser, no IP block.

DGHG_HTTP_PROXY is still honored (optional residential proxy fallback) for
the rare case a mirror starts stripping too.

Usage:  python3 dghg_http.py <embedUrl>
Prints JSON: {"ok": true, "m3u8": "..."} or {"ok": false, "reason": "..."}
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# Optional residential proxy. playmogo strips the /pass_md5/ token for
# datacenter IPs (Render gets a 5.6KB token-less page). A residential proxy
# makes the request originate from a clean IP and the token is served.
PROXY = os.environ.get("DGHG_HTTP_PROXY") or ""


def _opener():
    if PROXY:
        handler = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
        return urllib.request.build_opener(handler)
    return urllib.request.build_opener()


def _get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    opener = _opener()
    with opener.open(req, timeout=15) as r:
        return r.status, r.read().decode("utf-8", "replace")


def extract(embed_url):
    try:
        from urllib.parse import urlparse
        p = urlparse(embed_url)
        host = p.hostname
        seg = [s for s in p.path.split("/") if s]
        vid = seg[-1] if seg else ""
    except Exception:
        return {"ok": False, "reason": "bad-url"}

    if not host or not vid:
        return {"ok": False, "reason": "no-id"}

    # playmogo.com / myvidplay.com strip the /pass_md5/ token for datacenter
    # IPs (Render gets a ~5.6KB token-less page). The DoodStream network
    # shares the SAME video id + CDN across its mirrors; the public mirrors
    # (d0000d.com, dood.to, etc.) serve the full token page even from
    # datacenter IPs. Rewrite to a known-good mirror — no proxy, no browser.
    MIRROR = "d0000d.com"
    origin = "https://" + MIRROR
    ajax_url = f"{origin}/e/{vid}/ajax"
    try:
        status, html = _get(ajax_url, {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Referer": f"https://{MIRROR}/e/{vid}",
        })
    except urllib.error.HTTPError as e:
        if e.code in (403, 503):
            return {"ok": False, "reason": "cf-wall", "status": e.code}
        return {"ok": False, "reason": "http-error", "status": e.code}
    except Exception as e:
        return {"ok": False, "reason": "request-failed", "error": str(e)[:120]}

    if status != 200 or "just a moment" in html.lower():
        return {"ok": False, "reason": "cf-wall", "status": status}

    m = re.search(r"/pass_md5/[^\s\"'\\]+", html)
    if not m:
        # Surface what we actually got so we can diagnose IP-based stripping.
        title = ""
        tm = re.search(r"<title>(.*?)</title>", html, re.I)
        if tm:
            title = tm.group(1)[:80]
        return {"ok": False, "reason": "no-token", "status": status,
                "len": len(html), "title": title,
                "snippet": html[:300]}

    pm_url = origin + m.group(0)
    try:
        _, body = _get(pm_url, {
            "User-Agent": UA,
            "Accept": "*/*",
            "Referer": ajax_url,
            "X-Requested-With": "XMLHttpRequest",
        })
    except Exception as e:
        return {"ok": False, "reason": "passmd5-failed", "error": str(e)[:120]}

    mm = re.search(r"https?://[^\s\"'\\]+", body)
    if not mm:
        return {"ok": False, "reason": "no-m3u8"}
    return {"ok": True, "m3u8": mm.group(0)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage"}))
        sys.exit(1)
    print(json.dumps(extract(sys.argv[1])))
