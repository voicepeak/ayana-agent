"""Public web evidence with DNS-pinned connections and bounded downloads."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import uuid
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urljoin

import httpx

from .registry import ToolError


def public_url(value):
    try:
        if not isinstance(value, str) or len(value) > 3000:
            raise ValueError()
        url = httpx.URL(value)
        if url.scheme not in {"https", "http"} or not url.host or url.userinfo or url.port not in {80, 443, None}:
            raise ValueError()
        host = url.host.rstrip(".").lower()
        if host == "localhost" or host.endswith((".localhost", ".local")):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and (not address.is_global or getattr(address, "ipv4_mapped", None)):
            raise ValueError()
        return url
    except (ValueError, httpx.InvalidURL):
        raise ToolError("blocked_url", "只允许普通公网 HTTP/HTTPS 网页") from None


class PublicTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.inner = httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        original = public_url(str(request.url))
        addresses = await asyncio.get_running_loop().getaddrinfo(original.host, original.port or (443 if original.scheme == "https" else 80), type=socket.SOCK_STREAM)
        ips = list(dict.fromkeys(item[4][0] for item in addresses))
        if not ips or any(not ipaddress.ip_address(ip).is_global or getattr(ipaddress.ip_address(ip), "ipv4_mapped", None) for ip in ips):
            raise ToolError("blocked_address", "网页解析到了本地或内部地址")
        # Connect to exactly the validated address, preserving TLS verification and Host.
        request.url = original.copy_with(host=ips[0])
        request.headers["Host"] = original.netloc.decode("ascii")
        request.headers["Connection"] = "close"
        request.extensions["sni_hostname"] = original.host
        return await self.inner.handle_async_request(request)

    async def aclose(self):
        await self.inner.aclose()


class BodyText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.title = False
        self.heading = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "nav", "footer", "noscript", "svg"}:
            self.skip += 1
        if tag == "title":
            self.title = True
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "pre"} and not self.skip:
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "nav", "footer", "noscript", "svg"}:
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.title = False

    def handle_data(self, value):
        if self.title:
            self.heading.append(value)
        elif not self.skip:
            self.text.append(value)


class WebTools:
    def __init__(self, key_provider, transport=None, search_proxy=None, search_provider=None):
        self.key_provider = key_provider
        self.search_proxy = search_proxy or (lambda: "")
        self.search_provider = search_provider or (lambda: "auto")
        self.client = httpx.AsyncClient(transport=transport or PublicTransport(), timeout=25,
                                       follow_redirects=False, trust_env=False,
                                       headers={"User-Agent": "Ayana/0.3 public-evidence"})
        self.sources = {}

    @property
    def selected_search_provider(self):
        value = self.search_provider()
        return ("brave" if self.key_provider() else "bing") if value == "auto" else value

    @property
    def search_available(self):
        provider = self.selected_search_provider
        return provider == "bing" or (provider == "brave" and bool(self.key_provider()))

    def remember(self, value):
        sid = "source-" + uuid.uuid4().hex[:12]
        value = {"source_id": sid, **value}
        self.sources[sid] = value
        while len(self.sources) > 100:
            self.sources.pop(next(iter(self.sources)))
        return value

    async def download(self, url, headers=None, client=None):
        public_url(url)
        for hop in range(5):
            async with (client or self.client).stream("GET", url, headers=headers) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location or hop == 4:
                        raise ToolError("redirect_limit", "网页重定向次数过多")
                    url = str(public_url(urljoin(url, location)))
                    # Credentialed API calls must never forward secrets to another origin.
                    if headers:
                        raise ToolError("api_redirect", "搜索服务重定向被拒绝")
                    continue
                if response.status_code >= 400:
                    raise ToolError("web_http_error", f"网页服务返回 HTTP {response.status_code}")
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 2 * 1024 * 1024:
                        raise ToolError("web_size_limit", "网页内容超过 2 MiB")
                return url, response.headers.get("content-type", ""), bytes(raw), response.encoding or "utf-8"
        raise ToolError("redirect_limit", "网页重定向失败")

    async def fetch(self, url):
        if url in self.sources:
            url = self.sources[url]["url"]
        async with asyncio.timeout(25):
            final, content_type, raw, encoding = await self.download(url)
        if "html" in content_type:
            parser = BodyText()
            parser.feed(raw.decode(encoding, errors="replace"))
            content = "\n".join(line.strip() for line in "".join(parser.text).splitlines() if line.strip())
            title = "".join(parser.heading).strip()[:500]
        elif content_type.startswith("text/plain"):
            content, title = raw.decode(encoding, errors="replace"), final
        else:
            raise ToolError("unsupported_web_format", "首批网页读取仅支持 HTML 和纯文本")
        if len(content.strip()) < 30:
            raise ToolError("web_empty", "正文不足，可能需要浏览器加载或登录")
        return self.remember({"url": final, "title": title or final, "content": content[:12000],
                              "truncated": len(content) > 12000, "fetched_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()})

    async def search(self, query, count=5):
        provider = self.selected_search_provider
        if provider == "bing":
            return await self._bing_search(query, count)
        if provider != "brave":
            raise ToolError("search_unconfigured", "搜索方式必须为 auto、bing 或 brave")
        key = self.key_provider()
        if not key:
            raise ToolError("search_unconfigured", "搜索尚未配置 AYANA_SEARCH_API_KEY；仍可读取你提供的网址")
        url = str(httpx.URL("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": count}))
        async with asyncio.timeout(25):
            headers = {"X-Subscription-Token": key, "Accept": "application/json"}
            proxy = self.search_proxy()
            if proxy:
                # Only the fixed Brave API endpoint uses the trusted local
                # proxy's DNS. Arbitrary web.fetch targets retain DNS pinning.
                # Credentialed requests still refuse all redirects.
                async with httpx.AsyncClient(proxy=proxy, trust_env=False, timeout=25,
                                             follow_redirects=False, headers={"User-Agent": "Ayana/0.3 public-evidence"}) as client:
                    _, _, raw, _ = await self.download(url, headers, client=client)
            else:
                _, _, raw, _ = await self.download(url, headers)
        data = json.loads(raw)
        result = []
        for item in data.get("web", {}).get("results", [])[:count]:
            try:
                verified_url = str(public_url(item["url"]))
            except (ToolError, KeyError):
                continue
            result.append(self.remember({"title": str(item.get("title", ""))[:500], "url": verified_url,
                                         "summary": str(item.get("description", ""))[:1800], "published": item.get("page_age")}))
        return result

    async def _bing_search(self, query, count):
        # Adapted from ByteMind's RSS search approach, commit f259496e.
        # https://github.com/1024XEngineer/bytemind/blob/f259496ed7f959b3400c57e2d3d4d0a548d4b6a3/internal/tools/web_search.go
        url = str(httpx.URL("https://www.bing.com/search", params={"q": query, "format": "rss"}))
        async with asyncio.timeout(25):
            _, _, raw, _ = await self.download(url)
        if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
            raise ToolError("search_invalid_response", "搜索响应包含不支持的 XML 声明")
        try:
            feed = ET.fromstring(raw)
        except ET.ParseError:
            raise ToolError("search_invalid_response", "搜索未返回 RSS，可能触发了验证或服务页面发生变化") from None
        if feed.tag != "rss":
            raise ToolError("search_invalid_response", "搜索响应不是 RSS")
        def plain(value, limit):
            parser = BodyText()
            parser.feed(value or "")
            return " ".join("".join(parser.text).split())[:limit]
        result, seen = [], set()
        for item in feed.findall("./channel/item"):
            try:
                link = str(public_url((item.findtext("link") or "").strip()))
            except ToolError:
                continue
            if link in seen:
                continue
            seen.add(link)
            result.append(self.remember({"title": plain(item.findtext("title"), 500) or link,
                "url": link, "summary": plain(item.findtext("description"), 1800),
                "provider": "bing", "rank": len(result) + 1}))
            if len(result) >= count:
                break
        if not result:
            raise ToolError("search_empty", "搜索未返回有效结果；请调整关键词或稍后再试")
        return result

    async def close(self):
        await self.client.aclose()
