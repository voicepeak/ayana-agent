from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response

from .config import Settings
from .runtime import AgentRuntime


def create_app(token: str, settings=None, runtime=None):
    if len(token) < 24:
        raise ValueError("Runtime requires a strong per-launch token")
    settings = settings or Settings()
    runtime = runtime or AgentRuntime(settings)

    @asynccontextmanager
    async def lifespan(app):
        await runtime.start()
        yield
        await runtime.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def authenticated(auth):
        return hmac.compare_digest(auth or "", "Bearer " + token)

    @app.get("/health")
    async def health(request: Request):
        if not authenticated(request.headers.get("authorization")):
            raise HTTPException(401)
        return {"ok": True, "protocol_version": 1, "tts": runtime.tts.status}

    @app.get("/assets/{asset_id}")
    async def asset(asset_id: str, request: Request):
        if not authenticated(request.headers.get("authorization")):
            raise HTTPException(401)
        import json
        mapping = json.loads((settings.root / "characters/ayana/avatar-map.json").read_text(encoding="utf-8"))
        item = mapping["assets"].get(asset_id)
        if not item:
            raise HTTPException(404)
        root = (settings.root / settings.values["avatar_root"]).resolve()
        file = (root / item["file"]).resolve()
        if not file.is_relative_to(root):
            raise HTTPException(404)
        if not file.exists():
            file = root / "neutral.png"
        if file.exists():
            return FileResponse(file, media_type="image/png")
        return Response('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" rx="40" fill="#edf5ff"/><text x="150" y="230" text-anchor="middle" font-size="32" fill="#72a4e8">Ayana</text><text x="150" y="270" text-anchor="middle" font-size="16" fill="#5274a0">Configure avatar assets</text></svg>', media_type="image/svg+xml")

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        if not authenticated(ws.headers.get("authorization")):
            await ws.close(code=4401)
            return
        origin = ws.headers.get("origin")
        if origin and origin not in {"null", "file://", "ayana-app://desktop"}:
            await ws.close(code=4403)
            return
        await ws.accept()
        await runtime.connected(ws)
        try:
            while True:
                raw = await ws.receive_text()
                if len(raw) > 32768:
                    await ws.close(code=1009)
                    break
                try:
                    import json
                    await runtime.handle(json.loads(raw))
                except Exception as e:
                    await runtime.emit("error", source="command", message=str(e)[:500])
        except WebSocketDisconnect:
            pass
        finally:
            runtime.clients.discard(ws)
            if not runtime.clients:
                await runtime.cancel("client_disconnected")
    app.state.runtime = runtime
    return app
