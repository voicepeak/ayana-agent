"""Public web evidence with DNS-pinned connections and bounded downloads."""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import socket
import uuid
import unicodedata
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, parse_qs

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
        self.links = []
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "nav", "footer", "noscript", "svg"}:
            self.skip += 1
        if tag == "title":
            self.title = True
        if tag == "a" and not self.skip:
            self.anchor = {"url": dict(attrs).get("href", ""), "text": ""}
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "pre"} and not self.skip:
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            self.links.append(self.anchor)
            self.anchor = None
        if tag in {"script", "style", "nav", "footer", "noscript", "svg"}:
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.title = False

    def handle_data(self, value):
        if self.title:
            self.heading.append(value)
        elif not self.skip:
            self.text.append(value)
            if self.anchor is not None:
                self.anchor["text"] += value


class BingResults(HTMLParser):
    """Only organic result blocks; navigation and verification pages aren't results."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.items = [], []
        self.item = None
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "li" and "b_algo" in attrs.get("class", "").split() and self.item is None:
            self.item = {"title": "", "url": "", "summary": ""}
            self.depth = len(self.stack)
        if self.item is not None and tag == "a" and "h2" in self.stack and not self.item["url"]:
            self.item["url"] = attrs.get("href", "")
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag not in self.stack:
            return
        index = len(self.stack) - 1 - self.stack[::-1].index(tag)
        del self.stack[index:]
        if self.item is not None and len(self.stack) <= self.depth:
            if self.item["url"] and self.item["title"].strip():
                self.items.append(self.item)
            self.item = None

    def handle_data(self, value):
        if self.item is None or any(tag in self.stack for tag in {"script", "style"}):
            return
        if "h2" in self.stack:
            self.item["title"] += value
        elif "p" in self.stack:
            self.item["summary"] += value


def bing_result_url(value):
    # Bing HTML may wrap outbound links as /ck/a?...&u=a1<base64 URL>.
    url = urljoin("https://www.bing.com", value)
    parsed = urlparse(url)
    if parsed.hostname == "www.bing.com" and parsed.path == "/ck/a":
        wrapped = parse_qs(parsed.query).get("u", [""])[0]
        if not wrapped.startswith("a1"):
            raise ToolError("blocked_url", "搜索链接无法解析")
        try:
            url = base64.urlsafe_b64decode(wrapped[2:] + "=" * (-len(wrapped[2:]) % 4)).decode("utf-8")
        except (ValueError, UnicodeError):
            raise ToolError("blocked_url", "搜索链接无法解析") from None
    return str(public_url(url))


def normalized(value):
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


class WebTools:
    def __init__(self, key_provider, transport=None, search_proxy=None, search_provider=None):
        self.key_provider = key_provider
        self.search_proxy = search_proxy or (lambda: "")
        self.search_provider = search_provider or (lambda: "auto")
        self.client = httpx.AsyncClient(transport=transport or PublicTransport(), timeout=25,
                                       follow_redirects=False, trust_env=False,
                                       headers={"User-Agent": "Ayana/0.3 public-evidence"})
        self.sources = {}
        self.pages = {}

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

    def page(self, sid, offset, max_chars):
        page = self.pages[sid]
        content = page["content"]
        if offset >= len(content) and offset != 0:
            raise ToolError("invalid_offset", "读取位置超出正文范围")
        end = min(offset + max_chars, len(content))
        return {**self.sources[sid], "content": content[offset:end], "offset": offset,
                "total_chars": len(content), "truncated": end < len(content),
                "next_offset": end if end < len(content) else None, "links": page["links"],
                "links_total": page["links_total"], "links_truncated": page["links_total"] > len(page["links"])}

    async def fetch(self, url, offset=0, max_chars=12000):
        if type(offset) is not int or offset < 0 or type(max_chars) is not int or not 1000 <= max_chars <= 20000:
            raise ToolError("invalid_arguments", "网页分页参数无效")
        if url in self.pages and url in self.sources:
            return self.page(url, offset, max_chars)
        if offset:
            raise ToolError("source_expired", "续读需要仍在缓存中的 source_id；请从网址重新读取")
        if url in self.sources:
            url = self.sources[url]["url"]
        async with asyncio.timeout(25):
            final, content_type, raw, encoding = await self.download(url)
        links = []
        seen = set()
        if "html" in content_type:
            parser = BodyText()
            parser.feed(raw.decode(encoding, errors="replace"))
            content = "\n".join(line.strip() for line in "".join(parser.text).splitlines() if line.strip())
            title = "".join(parser.heading).strip()[:500]
            for item in parser.links:
                if not item["url"] or item["url"].startswith("#"):
                    continue
                try:
                    link = str(public_url(urljoin(final, item["url"])))
                except ToolError:
                    continue
                if link not in seen:
                    seen.add(link)
                    if len(links) < 100:
                        links.append({"url": link, "text": " ".join(item["text"].split())[:300]})
        elif content_type.startswith("text/plain"):
            content, title = raw.decode(encoding, errors="replace"), final
        else:
            raise ToolError("unsupported_web_format", "首批网页读取仅支持 HTML 和纯文本")
        if len(content.strip()) < 30:
            raise ToolError("web_empty", "正文不足，可能需要浏览器加载或登录")
        source = self.remember({"url": final, "title": title or final,
                               "fetched_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()})
        sid = source["source_id"]
        self.pages[sid] = {"content": content, "links": links, "links_total": len(seen)}
        # Bounded full-page cache; source metadata remains independently bounded.
        while len(self.pages) > 16 or sum(len(p["content"]) for p in self.pages.values()) > 8 * 1024 * 1024:
            self.pages.pop(next(iter(self.pages)))
        return self.page(sid, 0, max_chars)

    async def search(self, query, count=5, subject=None, progress=None):
        provider = self.selected_search_provider
        if provider == "bing":
            async with asyncio.timeout(25):
                result = await self._bing_search(query, count, progress)
                exact = normalized(subject) if subject else ""
                if exact and query.strip() != '"' + subject.strip('"') + '"' and not any(
                        exact in normalized(item["title"] + " " + item["summary"]) for item in result):
                    if progress:
                        await progress("exact_search", "结果没有提到这个名称，正在按名称重新查找")
                    result = await self._bing_search('"' + subject.strip('"') + '"', count, progress)
                    for item in result:
                        item["query_used"] = '"' + subject.strip('"') + '"'
                if exact:
                    for item in result:
                        # A hint for inspecting results, never proof of relevance or identity.
                        item["subject_mentioned"] = exact in normalized(item["title"] + " " + item["summary"])
                return result
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

    async def _bing_search(self, query, count, progress=None):
        try:
            return await self._bing_rss(query, count)
        except ToolError as error:
            if error.code not in {"search_invalid_response", "search_empty"}:
                raise
            if progress:
                await progress("search_fallback", "搜索服务返回异常，正在换一种方式查找")
            url = str(httpx.URL("https://www.bing.com/search", params={"q": query}))
            try:
                _, _, raw, encoding = await self.download(url)
                parser = BingResults()
                parser.feed(raw.decode(encoding, errors="replace"))
                result, seen = [], set()
                for item in parser.items:
                    try:
                        link = bing_result_url(item["url"])
                    except ToolError:
                        continue
                    if link in seen:
                        continue
                    seen.add(link)
                    result.append(self.remember({"title": " ".join(item["title"].split())[:500],
                        "url": link, "summary": " ".join(item["summary"].split())[:1800],
                        "provider": "bing", "format": "html", "rank": len(result) + 1}))
                    if len(result) >= count:
                        break
                if result:
                    return result
            except ToolError:
                pass
            raise error

    async def _bing_rss(self, query, count):
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
