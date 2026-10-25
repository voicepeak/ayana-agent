from collections import defaultdict, deque
import hashlib
import hmac
from pathlib import Path
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .reader import MonitorReader


COOKIE = "ayana_monitor_session"


def create_app(reader: MonitorReader, admin_token: str):
    if len(admin_token) < 24:
        raise ValueError("Monitor authentication requires a random local token")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
    session = hmac.new(admin_token.encode(), b"ayana-monitor-browser-session-v1", hashlib.sha256).hexdigest()
    attempts = defaultdict(deque)
    static = Path(__file__).with_name("static")

    @app.middleware("http")
    async def private_response(request, call_next):
        response = await call_next(request)
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"})
        return response

    def authenticated(request):
        supplied = request.cookies.get(COOKIE, "")
        return bool(supplied) and hmac.compare_digest(supplied.encode("utf-8"), session.encode("utf-8"))

    def authorize(request):
        if not authenticated(request):
            raise HTTPException(401, "请使用本机管理员口令登录")

    def same_origin(request):
        if request.headers.get("origin") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "仅允许同源操作")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html")

    @app.get("/api/session")
    def session_state(request: Request):
        return {"authenticated": authenticated(request)}

    @app.post("/api/login")
    async def login(request: Request):
        same_origin(request)
        client = request.client.host if request.client else "local"
        now, recent = time.monotonic(), attempts[client]
        while recent and recent[0] < now - 60:
            recent.popleft()
        if len(recent) >= 10:
            raise HTTPException(429, "请稍后再试")
        raw = await request.body()
        if len(raw) > 2048:
            raise HTTPException(413)
        try:
            import json
            token = json.loads(raw).get("token")
        except (ValueError, AttributeError):
            token = None
        if not isinstance(token, str) or not hmac.compare_digest(token.encode("utf-8"), admin_token.encode("utf-8")):
            recent.append(now)
            raise HTTPException(401, "管理员口令不正确")
        recent.clear()
        response = JSONResponse({"ok": True})
        response.set_cookie(COOKIE, session, httponly=True, samesite="strict", max_age=8 * 3600, path="/")
        return response

    @app.post("/api/logout")
    def logout(request: Request):
        same_origin(request)
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.get("/api/snapshot")
    def snapshot(request: Request, user_id: str = "", conversation_id: str = "", hours: int = 24,
                 include_inactive: bool = False, issues_only: bool = False):
        authorize(request)
        if hours not in {1, 6, 24, 72} or len(user_id) > 100 or len(conversation_id) > 128:
            raise HTTPException(400, "无效筛选条件")
        return reader.snapshot(user_id, conversation_id, hours, include_inactive, issues_only)

    @app.get("/api/turn/{turn_id}")
    def detail(turn_id: str, request: Request, user_id: str, hours: int = 24):
        authorize(request)
        if hours not in {1, 6, 24, 72} or not user_id or len(user_id) > 100 or len(turn_id) > 128:
            raise HTTPException(400)
        result = reader.detail(user_id, turn_id, hours)
        if result is None:
            raise HTTPException(404, "本轮记录不在当前读取窗口")
        return result

    app.mount("/static", StaticFiles(directory=static), name="static")
    return app
