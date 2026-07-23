#!/usr/bin/env python3
"""DGHG HTTP-only extraction (no browser, no Cloudflare JS challenge).

Cloudflare only challenges the *pretty* HTML document and TLS fingerprints
from undici/curl_cffi. Python's stdlib urllib (OpenSSL, HTTP/1.1) passes the
/e/<id>/ajax endpoint, which embeds the /pass_md5/<hash>/<token> URL. We grab
that and GET it; the body is the CDN m3u8. This works from datacenter IPs
(Render) because there is no managed-challenge / Turnstile to solve.

Usage:  python3 dghg_http.py <embedUrl>
Prints JSON: {"ok": true, "m3u8": "..."} or {"ok": false, "reason": "..."}
"""
import json
import re
import sys
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, r.read().decode("utf-8", "replace")


# DoodStream-family hosts. playmogo.com / myvidplay.com strip the
# /pass_md5/ token for datacenter IPs (Render gets a ~5.6KB token-less
# page). The Dood network shares the SAME video id + CDN across its
# mirrors; the public mirrors (d0000d.com, dood.to, ds2play.com,
# vide0.net, ...) serve the full token page even from datacenter IPs.
# So for a stripped host we rewrite to a known-good mirror.
STRIPPED_HOSTS = {"playmogo.com", "myvidplay.com"}
MIRROR = "d0000d.com"
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def extract(embed_url):
    try:
        from urllib.parse import urlparse
        p = urlparse(embed_url)
        host = p.hostname or ""
        seg = [s for s in p.path.split("/") if s]
        vid = seg[-1] if seg else ""
    except Exception:
        return {"ok": False, "reason": "bad-url"}

    if not host or not vid:
        return {"ok": False, "reason": "no-id"}

    # Only rewrite Dood-family hosts. Anything else (echovideo, etc.)
    # is left untouched — we never invent a mirror for an unknown host.
    if host.lower() in STRIPPED_HOSTS:
        host = MIRROR

    origin = "https://" + host
    ajax_url = f"{origin}/e/{vid}/ajax"
    try:
        status, html = _get(ajax_url, {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Referer": f"{origin}/e/{vid}",
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
        title = ""
        tm = re.search(r"<title>(.*?)</title>", html, re.I)
        if tm:
            title = tm.group(1)[:80]
        return {"ok": False, "reason": "no-token", "status": status,
                "len": len(html), "title": title, "snippet": html[:300]}

    pm_url = origin + m.group(0)
    token_seg = m.group(0).rstrip("/").split("/")[-1]
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
    # recloudstream builds the final URL as: <pass_md5 body> + 10 random
    # chars + "?token=<last path seg of /pass_md5/>". Mirror that exactly.
    import random
    rand = "".join(random.choice(ALPHABET) for _ in range(10))
    m3u8 = f"{mm.group(0)}{rand}?token={token_seg}"
    return {"ok": True, "m3u8": m3u8}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage"}))
        sys.exit(1)
    print(json.dumps(extract(sys.argv[1])))
