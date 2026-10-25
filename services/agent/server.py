from __future__ import annotations

import hmac
import hashlib
import importlib.metadata
import os
import time
import tomllib
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .runtime import AgentRuntime
from .avatars import AvatarCatalog
from .characters import character_entry
from .mobile import COOKIE_MAX_AGE, COOKIE_NAME


def _version(root: Path | None = None) -> str:
    try:
        return importlib.metadata.version("ayana-agent")
    except importlib.metadata.PackageNotFoundError:
        pass
    try:
        project = tomllib.loads((Path(root or ".") / "pyproject.toml").read_text(encoding="utf-8"))
        return str(project["project"]["version"])
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return "0.0.0"


def create_app(token: str, settings=None, runtime=None, *, mobile_token: str | None = None,
               mobile_root: Path | str | None = None, mobile_apk: Path | str | None = None,
               allowed_origins=None):
    if len(token) < 24:
        raise ValueError("Runtime requires a strong per-launch token")
    settings = settings or Settings()
    runtime = runtime or AgentRuntime(settings)
    preview_catalogs = {}
    origins = {origin.strip() for origin in (allowed_origins or []) if origin and origin.strip()}
    origins.update(origin.strip() for origin in os.environ.get("AYANA_ALLOWED_ORIGINS", "").split(",") if origin.strip())
    mobile_root = Path(mobile_root) if mobile_root else None
    mobile_apk = Path(mobile_apk) if mobile_apk else None
    has_mobile = bool(mobile_root and (mobile_root / "index.html").is_file())

    def apk_file():
        if mobile_apk is None:
            return None
        if mobile_apk.is_file():
            return mobile_apk
        if mobile_apk.is_dir():
            candidates = sorted(mobile_apk.glob("*.apk"), key=lambda path: path.stat().st_mtime, reverse=True)
            return candidates[0] if candidates else None
        return None

    @asynccontextmanager
    async def lifespan(app):
        await runtime.start()
        yield
        await runtime.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["capacitor://localhost", "ionic://localhost", "https://localhost",
                       "http://localhost", *sorted(origins)],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
    )

    def bearer_ok(auth):
        return hmac.compare_digest(auth or "", "Bearer " + token)

    def mobile_bearer_ok(auth):
        return bool(mobile_token) and hmac.compare_digest(auth or "", "Bearer " + mobile_token)

    def cookie_ok(value):
        return bool(mobile_token) and hmac.compare_digest(value or "", mobile_token)

    def ticket_ok(value):
        if not mobile_token or not isinstance(value, str) or "." not in value:
            return False
        expiry, signature = value.split(".", 1)
        try:
            when = int(expiry)
        except ValueError:
            return False
        if when < time.time():
            return False
        expected = hmac.new(mobile_token.encode("utf-8"), expiry.encode("ascii"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)

    def issue_ticket(seconds=120):
        expiry = str(int(time.time()) + seconds)
        signature = hmac.new(mobile_token.encode("utf-8"), expiry.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{expiry}.{signature}"

    def authenticated(request: Request):
        return (bearer_ok(request.headers.get("authorization"))
                or mobile_bearer_ok(request.headers.get("authorization"))
                or cookie_ok(request.cookies.get(COOKIE_NAME, "")))

    def origin_allowed(origin, host):
        if not origin:
            return True
        if origin in {"null", "file://", "ayana-app://desktop", "capacitor://localhost",
                      "ionic://localhost", "https://localhost", "http://localhost"}:
            return True
        if origin in origins:
            return True
        parsed = urlparse(origin)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            request_host = (host or "").rsplit(":", 1)[0].strip("[]").lower()
            if parsed.hostname.lower() == request_host:
                return True
            if parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}:
                return True
        return False

    def secure_request(request: Request):
        forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        return request.url.scheme == "https" or forwarded == "https"

    @app.get("/health")
    async def health(request: Request):
        if not bearer_ok(request.headers.get("authorization")):
            raise HTTPException(401)
        return {"ok": True, "protocol_version": 1, "tts": runtime.tts.status,
                "settings_file": str(settings.path), "settings_exists": settings.path.is_file(),
                "provider": settings.values["provider"], "voice_mode": settings.values.get("voice", {}).get("voice_mode", "auto"),
                "mobile": has_mobile}

    @app.post("/shutdown")
    async def shutdown(request: Request):
        if not bearer_ok(request.headers.get("authorization")):
            raise HTTPException(401)
        import asyncio
        async def stop():
            await runtime.close()
            server = getattr(app.state, "server", None)
            if server:
                server.should_exit = True
        asyncio.create_task(stop())
        return {"stopping": True}

    @app.get("/debug/prompts/export")
    async def prompt_export(request: Request):
        if not bearer_ok(request.headers.get("authorization")):
            raise HTTPException(401)
        import json
        return Response(json.dumps(runtime.prompt_trace.export(), ensure_ascii=False, indent=2),
                        media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="ayana-prompts.json"',
                                 "Cache-Control": "no-store"})

    @app.get("/mobile/session")
    async def mobile_session_state(request: Request):
        response = JSONResponse({"paired": cookie_ok(request.cookies.get(COOKIE_NAME, "")),
                                 "available": bool(mobile_token),
                                 "android_apk": apk_file() is not None})
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/mobile/app.apk")
    async def mobile_apk_download():
        file = apk_file()
        if file is None:
            raise HTTPException(404, "Android package is not available")
        return FileResponse(file, media_type="application/vnd.android.package-archive", filename=file.name)

    @app.post("/mobile/ticket")
    async def mobile_ticket(request: Request):
        if not (mobile_bearer_ok(request.headers.get("authorization"))
                or cookie_ok(request.cookies.get(COOKIE_NAME, ""))):
            raise HTTPException(401, "Invalid mobile token")
        response = JSONResponse({"ticket": issue_ticket(), "expires_in": 120})
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/mobile/session")
    async def mobile_session(request: Request):
        if not mobile_token:
            raise HTTPException(503, "Mobile access is not configured")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid request")
        supplied = body.get("token") if isinstance(body, dict) else None
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied.strip(), mobile_token):
            raise HTTPException(401, "Invalid mobile token")
        response = JSONResponse({"ok": True})
        response.set_cookie(COOKIE_NAME, mobile_token, max_age=COOKIE_MAX_AGE, httponly=True,
                            samesite="lax", secure=secure_request(request), path="/")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.delete("/mobile/session")
    async def mobile_logout(request: Request):
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE_NAME, path="/")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/mobile/bootstrap")
    async def mobile_bootstrap(request: Request):
        if not authenticated(request):
            raise HTTPException(401)
        return {"version": _version(settings.root), "protocol_version": 1,
                "settings": settings.public(), "tts": runtime.tts.status,
                "avatar_character": runtime.avatars.character,
                "avatar_costume": settings.values.get("avatar_costume", "校服"),
                "default_asset_id": runtime.avatars.mapping.get("default_asset_id", "neutral")}

    @app.get("/assets/{asset_id}")
    async def asset(asset_id: str, request: Request):
        if not authenticated(request):
            raise HTTPException(401)
        character = request.query_params.get("character")
        catalog = runtime.avatars
        if character and character != getattr(catalog, "character", None):
            try:
                character_entry(settings.root, character)
                if character not in preview_catalogs:
                    preview_catalogs[character] = AvatarCatalog(settings.root, character=character)
                catalog = preview_catalogs[character]
            except (ValueError, OSError):
                raise HTTPException(404, "Character resource is not installed")
        file = catalog.asset_file(settings.root, asset_id)
        if file is not None:
            return FileResponse(file, media_type="image/png")
        raise HTTPException(404, "Character resource is not installed")

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        if not (bearer_ok(ws.headers.get("authorization"))
                or mobile_bearer_ok(ws.headers.get("authorization"))
                or cookie_ok(ws.cookies.get(COOKIE_NAME, ""))
                or ticket_ok(ws.query_params.get("ticket"))):
            await ws.close(code=4401)
            return
        if not origin_allowed(ws.headers.get("origin"), ws.headers.get("host", "")):
            await ws.close(code=4403)
            return
        client = None
        if ws.query_params.get("client") == "mobile":
            client = {"kind": "mobile", "audio_format": "pcm_s16le"}
            if ws.query_params.get("audio") == "f32":
                client["audio_format"] = "pcm_f32le"
        await ws.accept()
        try:
            await runtime.connected(ws, client=client)
            while True:
                raw = await ws.receive_text()
                if len(raw) > 2 * 1024 * 1024:
                    await ws.close(code=1009)
                    break
                command = None
                try:
                    import json
                    command = json.loads(raw)
                    await runtime.handle(command)
                except Exception as e:
                    if runtime.closing or runtime.closed:
                        await ws.close(code=1001)
                        break
                    request_id = command.get("request_id") if isinstance(command, dict) else None
                    await runtime.emit("error", source="command", message=str(e)[:500], request_id=request_id)
        except WebSocketDisconnect:
            pass
        except RuntimeError:
            if not runtime.closing and not runtime.closed:
                raise
            with suppress(RuntimeError, WebSocketDisconnect):
                await ws.close(code=1001)
        finally:
            await runtime.disconnected(ws)

    if has_mobile:
        app.mount("/m", StaticFiles(directory=str(mobile_root), html=True), name="mobile")

        @app.get("/")
        async def mobile_index():
            return RedirectResponse(url="/m/", status_code=307)

    app.state.runtime = runtime
    return app
