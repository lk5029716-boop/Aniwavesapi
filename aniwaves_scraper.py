
"""
aniwaves.ru scraper — direct M3U8, no iframe, no Cloudflare /pass_md5/ problems.

Requires: pip install curl_cffi beautifulsoup4
Why curl_cffi: it impersonates Chrome's TLS + HTTP/2 fingerprint, which is what
CF actually checks on /pass_md5/. Works from datacenter IPs.
"""
import re, json, base64, time, os, logging
from urllib.parse import urlparse, urljoin
from curl_cffi import requests as cffi
from bs4 import BeautifulSoup

BASE = "https://aniwaves.ru"
IMPERSONATE = "chrome124"

logger = logging.getLogger(__name__)

def new_session():
    s = cffi.Session(impersonate=IMPERSONATE)
    s.headers.update({
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE + "/",
    })
    return s

def list_servers(s, anime_id: int, ep: int):
    r = s.get(f"{BASE}/ajax/server/list", params={"servers": anime_id, "eps": ep})
    r.raise_for_status()
    html = r.json()["result"]
    out = []
    for m in re.finditer(
        r'data-ep-id="(\d+)"\s+data-cmid="\d+"\s+data-sv-id="(\d+)"\s+data-link-id="([^"]+)">([^<]+)<',
        html,
    ):
        out.append({"ep_id": m.group(1), "sv_id": m.group(2),
                    "link_id": m.group(3), "name": m.group(4).strip()})
    return out

def get_embed_url(s, link_id: str):
    r = s.get(f"{BASE}/ajax/sources",
              params={"id": link_id, "asi": 0, "autoPlay": 0},
              headers={"X-Requested-With": "XMLHttpRequest",
                       "Referer": f"{BASE}/watch/"})
    r.raise_for_status()
    return r.json()["result"]["url"]   # https://play.echovideo.ru/embed-1/<key>?...

def resolve_m3u8(s, embed_url: str):
    """Hit the player domain directly. curl_cffi handles the CF TLS check.
    If ANIWAVES_PROXY_URL is set, route myvidplay/playmogo requests through it."""
    
    proxy_url = os.environ.get("ANIWAVES_PROXY_URL")
    pu = urlparse(embed_url)
    origin = f"{pu.scheme}://{pu.netloc}"
    key = pu.path.rsplit("/", 1)[-1]
    
    # Determine if this host needs proxying
    needs_proxy = proxy_url and any(
        h in pu.hostname for h in ("myvidplay", "playmogo")
    )
    
    def proxied_get(url, **kwargs):
        """Route request through CF Worker proxy if needed."""
        if needs_proxy and any(h in url for h in ("myvidplay", "playmogo")):
            separator = "&" if "?" in proxy_url else "?"
            proxy_target = f"{proxy_url}{separator}url={url}"
            logger.debug(f"[proxy] routing via CF Worker: {url[:80]}")
            return s.get(proxy_target, **kwargs)
        return s.get(url, **kwargs)

    # warm up cookies on player origin
    s.get(embed_url, headers={"Referer": BASE + "/"})

    headers = {
        "Referer": embed_url,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/plain, */*",
    }

    # Echovideo (primary aniwaves CDN) is a plain getSources with a STRING m3u8,
    # NOT an ajax path and NOT encrypted. Try the real endpoints first.
    host = pu.hostname or ""
    echovideo_info = None
    if "echovideo" in host or "echo" in host:
        try:
            r = s.get(f"{origin}/embed-1/getSources", params={"id": key},
                      headers=headers, timeout=15)
            if r.status_code == 200 and r.text.strip().startswith("{"):
                echovideo_info = r.json()
        except Exception:
            pass

    if echovideo_info and "sources" in echovideo_info:
        return echovideo_info

    # mediainfo (some builds) + getSources (rabbitstream-style)
    info = None
    for path in (f"/mediainfo/{key}", f"/embed-1/getSources?id={key}"):
        try:
            r = proxied_get(origin + path, headers=headers, timeout=15)
            if r.status_code == 200 and r.text.strip().startswith(("{", "[")):
                info = r.json()
                break
        except Exception:
            pass

    if info and "sources" in info:
        return info  # already decoded JSON with sources/tracks

    # DGHG / playmogo: must extract pass_md5 hash+token from page HTML
    # then call /pass_md5/<hash>/<token> to get base CDN URL
    page_r = proxied_get(embed_url, headers={"Referer": BASE + "/"}, timeout=15)
    if page_r.status_code == 200:
        # Look for /pass_md5/<hash>/<token> in the page
        m = re.search(r"/pass_md5/([a-f0-9]{32})/([a-zA-Z0-9_-]+)", page_r.text)
        if m:
            md5_hash = m.group(1)
            token = m.group(2)
            pass_r = proxied_get(
                f"{origin}/pass_md5/{md5_hash}/{token}",
                headers=headers, timeout=15, allow_redirects=True,
            )
            if pass_r.status_code == 200:
                txt = pass_r.text.strip()
                if txt.startswith("http"):
                    # txt is the base CDN URL
                    return {"sources": [{"file": txt + "/index-f1-v1-a1.m3u8",
                                         "type": "hls"}], "raw": txt, "token": token}

    raise RuntimeError(f"player {origin} did not return sources (status {page_r.status_code})")

def episode_streams(anime_id: int, ep: int):
    s = new_session()
    streams = []
    for srv in list_servers(s, anime_id, ep):
        try:
            embed = get_embed_url(s, srv["link_id"])
            data = resolve_m3u8(s, embed)
            streams.append({"server": srv["name"], "embed": embed, "data": data})
        except Exception as e:
            streams.append({"server": srv["name"], "error": str(e)})
    return streams

if __name__ == "__main__":
    import sys
    # Mode 1: --server <embed_url>  → resolve a single embed URL (used by dghg.ts)
    if "--server" in sys.argv:
        url_idx = sys.argv.index("--server") + 1
        if url_idx < len(sys.argv):
            embed_url = sys.argv[url_idx]
            s = new_session()
            try:
                data = resolve_m3u8(s, embed_url)
                # Extract m3u8 from sources or raw
                m3u8 = None
                if isinstance(data, dict):
                    sources = data.get("sources", [])
                    if sources and isinstance(sources[0], dict):
                        m3u8 = sources[0].get("file") or sources[0].get("src")
                    if not m3u8 and "raw" in data:
                        raw = data["raw"]
                        base = raw.rsplit("/", 1)[0]
                        m3u8 = base + "/index-f1-v1-a1.m3u8"
                if not m3u8:
                    m3u8 = embed_url
                print(json.dumps({"ok": True, "m3u8": m3u8, "referer": embed_url, "expiry": int(time.time() * 1000) + 3600000}))
            except Exception as e:
                print(json.dumps({"ok": False, "error": str(e)}))
        else:
            print(json.dumps({"ok": False, "error": "missing URL after --server"}))
        sys.exit(0)

    # Mode 2: <anime_id> <ep>  → full episode scan
    aid = int(sys.argv[1]) if len(sys.argv) > 1 else 82499
    ep  = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    print(json.dumps(episode_streams(aid, ep), indent=2)[:4000])
