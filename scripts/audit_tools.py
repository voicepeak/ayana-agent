"""Real Windows tool audit using isolated data and an owned desktop demo.

No credentials or personal window contents are written to the report. Model
desktop execution is opt-in; it operates only on the newly created demo window.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


class SilentVoice:
    status = {"state": "ready", "engine": "silent"}
    async def close(self): pass
    async def cancel(self, generation): pass


async def audit(options):
    sys.path.insert(0, str(options.runtime_root))
    from services.agent.config import Settings
    from services.agent.runtime import AgentRuntime
    from services.agent.tasks import TaskRunner

    output = ROOT / ".runtime/benchmarks/tool-audit" / str(time.time_ns())
    output.mkdir(parents=True)
    personal = Settings(options.runtime_root, options.profile)
    settings = Settings(options.runtime_root, output)
    settings.values = dict(personal.values)
    settings.values.update(save_history=True, voice={"voice_mode": "silent"},
                           task_limits={"rounds": 8, "calls": 8, "seconds": 120})
    settings.key = personal.key
    settings.search_key = personal.search_key
    runtime = AgentRuntime(settings, tts=SilentVoice())
    runtime.computer.installation = lambda: original_installation
    from services.agent.computer_use import ComputerUse
    original_installation = ComputerUse(personal).installation()
    runtime.active_task = TaskRunner("Tool audit on owned fixtures", {})
    runtime.write_cancel = threading.Event()
    report = {"runtime_root": str(options.runtime_root), "output": str(output),
              "configuration": {"full_access": runtime.full_access,
                  "send_screenshot": settings.values.get("send_screenshot"),
                  "model_configured": bool(personal.key()),
                  "search_configured": runtime.web.search_available,
                  "search_provider": runtime.web.selected_search_provider,
                  "search_credential_present": bool(personal.search_key()),
                  "computer": runtime.computer.status},
              "registered": list(runtime.registry.tools),
              "initially_visible": [t.name for t in runtime.registry.active_tools()],
              "checks": []}
    original_emit = runtime.emit
    async def emit(event_type, **payload):
        if event_type == "tool.failed":
            report.setdefault("executor_errors", []).append({k: payload[k] for k in ("tool", "code", "message") if k in payload})
        return await original_emit(event_type, **payload)
    runtime.emit = emit
    original_run = runtime.computer.run
    async def computer_run(*args, **kwargs):
        result = await original_run(*args, **kwargs)
        report["computer_receipt"] = {k: result[k] for k in ("status", "reason", "actions", "steps", "model_requests", "report_path") if k in result}
        return result
    runtime.computer.run = computer_run
    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    async def probe(name, args, check=None, summarize=None):
        start = time.monotonic()
        try:
            result = await runtime.registry.execute(name, args)
            if check:
                assert check(result), "Execution receipt did not match independently observed fixture"
            row = {"tool": name, "status": "passed", "evidence": summarize(result) if summarize else "Actual executor returned successfully"}
        except Exception as error:
            result = None
            row = {"tool": name, "status": "blocked" if getattr(error, "code", "") == "tool_unavailable" else "failed",
                   "code": getattr(error, "code", type(error).__name__), "message": str(error)[:500]}
        row["duration_ms"] = round((time.monotonic() - start) * 1000)
        report["checks"].append(row)
        save()
        print(json.dumps(row, ensure_ascii=False), flush=True)
        return result

    async def wait_state(key, expected):
        for _ in range(40):
            if state()[key] == expected:
                return True
            await asyncio.sleep(.05)
        return False

    demo = None
    server = None
    try:
        await probe("web.search", {"query": "Ayana tool audit", "count": 1})
        await probe("web.fetch", {"url": "https://example.com"},
                    lambda r: r["title"] == "Example Domain" and "domain" in r["content"].lower(),
                    lambda r: {"url": r["url"], "title": r["title"], "characters": len(r["content"])})
        fixture = output / "fixture.txt"
        created = await probe("files.create", {"root_id": "output", "path": "fixture.txt", "content": "audit original\nunique-tool-audit-token\n"},
                              lambda r: (output / "artifacts/fixture.txt").read_text(encoding="utf-8").startswith("audit original"))
        fixture = output / "artifacts/fixture.txt"
        read = await probe("files.read", {"root_id": "output", "path": "fixture.txt"},
                           lambda r: r["content"] == fixture.read_text(encoding="utf-8") and bool(r["sha256"]))
        await probe("files.list", {"root_id": "output", "limit": 10}, lambda r: any(Path(x["path"]).name == "fixture.txt" for x in r["entries"]))
        await probe("files.find", {"root_id": "output", "query": "fixture"}, lambda r: bool(r["matches"]))
        await probe("files.search", {"root_id": "output", "query": "unique-tool-audit-token"}, lambda r: bool(r["matches"]))
        edited = None
        if read:
            edited = await probe("files.propose_edit", {"root_id": "output", "path": "fixture.txt", "base_sha256": read["sha256"], "content": "audit edited\n"},
                                 lambda r: fixture.read_text(encoding="utf-8") == "audit edited\n")
        if edited:
            await probe("files.propose_restore", {"artifact_id": edited["artifact_id"]},
                        lambda r: fixture.read_text(encoding="utf-8") == read["content"])
        await probe("shell.run", {"command": "[IO.File]::WriteAllText('shell-proof.txt', 'shell verified'); Write-Output 'shell verified'", "cwd": str(output), "timeout_seconds": 10},
                    lambda r: r["exit_code"] == 0 and (output / "shell-proof.txt").read_text() == "shell verified")
        apps = await probe("apps.search", {"query": "calculator", "limit": 5}, lambda r: bool(r), lambda r: {"matches": len(r), "names": [x["name"] for x in r]})
        if apps:
            await probe("apps.open", {"app_id": apps[0]["app_id"]}, lambda r: r["status"] in {"open_requested", "window_observed"},
                        lambda r: {"status": r["status"], "window_count": len(r.get("windows", []))})
        await probe("files.open", {"root_id": "output", "path": "fixture.txt"}, lambda r: r["status"] == "open_requested",
                    lambda r: {"status": r["status"], "path": r["absolute_path"]})

        opened = threading.Event()
        class Page(BaseHTTPRequestHandler):
            def do_GET(self):
                opened.set()
                body = b"<title>Ayana tool audit</title><p>Browser opening verified. This tab can be closed.</p>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        async def browser_open(**args):
            result = await runtime._web_open(**args)
            result["page_requested"] = await asyncio.to_thread(opened.wait, 10)
            return result
        runtime.registry.tools["web.open"].handler = browser_open
        await probe("web.open", {"url": f"http://127.0.0.1:{server.server_port}/tool-audit"}, lambda r: r["page_requested"],
                    lambda r: {"status": r["status"], "page_requested": r["page_requested"]})
        await asyncio.sleep(2)

        state_path = output / "demo-state.json"
        demo = subprocess.Popen([sys._base_executable, "-m", "native.windows.demo_target", "--state", str(state_path), "--auto-close", "240"],
                                cwd=options.runtime_root, creationflags=subprocess.CREATE_NO_WINDOW)
        def state():
            for _ in range(10):
                try: return json.loads(state_path.read_text(encoding="utf-8"))
                except (OSError, ValueError): time.sleep(.03)
            raise RuntimeError("Demo state unavailable")
        for _ in range(100):
            if state_path.exists(): break
            await asyncio.sleep(.1)
        initial = state()
        # The user's desktop assistant can itself be always-on-top. Raise only
        # this owned fixture so its input points are actually unobscured.
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user32.SetWindowPos.restype = wintypes.BOOL
        if not user32.SetWindowPos(initial["hwnd"], wintypes.HWND(-1), 0, 0, 0, 0, 0x3):
            raise ctypes.WinError(ctypes.get_last_error())
        windows = await probe("windows.list", {}, lambda r: any(x["process_id"] == demo.pid for x in r), lambda r: {"window_count": len(r), "owned_demo_present": any(x["process_id"] == demo.pid for x in r)})
        if windows:
            selected = next((x for x in windows if x["process_id"] == demo.pid), None)
            if selected:
                await probe("windows.select", {"window_id": selected["window_id"]}, lambda r: r["target"]["hwnd"] == initial["hwnd"], lambda r: {"snapshot_id": r["snapshot_id"], "image_size_px": r["image_size_px"]})
        if runtime.target:
            api = runtime.desktop._api
            if not api.focus(initial["hwnd"]):
                # Fixture preparation: a checked click on this test window's
                # own caption establishes normal Windows foreground ownership.
                bounds = api.identity(initial["hwnd"])["bounds"]
                caption = (bounds["left"] + 50, bounds["top"] + 20)
                assert api.point_root(*caption) == initial["hwnd"], "Owned caption is obscured"
                api.send([api.move_input(*caption)])
                await asyncio.sleep(.1)
                api.send([api.mouse(flags=2), api.mouse(flags=4)])
                await asyncio.sleep(.2)
            assert api.foreground() == initial["hwnd"], "Owned fixture could not acquire focus"
            await asyncio.sleep(.3)
            await probe("capture_target", {}, lambda r: bool(r["snapshot_id"]), lambda r: {"snapshot_id": r["snapshot_id"], "image_size_px": r["image_size_px"]})
            await probe("observe_controls", {}, summarize=lambda r: {"returned_type": type(r).__name__, "control_count": len(r.get("controls", [])) if isinstance(r, dict) else len(r)})
            def point(name):
                widget = state()["widgets"][name]
                t = runtime.snapshot["transform"]
                return {"x": round((widget["x"] + widget["width"] / 2 - t["origin_x"]) / t["scale_x"]),
                        "y": round((widget["y"] + widget["height"] / 2 - t["origin_y"]) / t["scale_y"])}
            typed = await probe("desktop.step", {"snapshot_id": runtime.snapshot["snapshot_id"], "kind": "type", "point": point("entry"), "text": "desktop audit verified"})
            await asyncio.sleep(.2)
            if typed:
                assert await wait_state("message", "desktop audit verified"), "Typed text did not reach the demo"
                await runtime.capture()
                # Complete the actual click before checking the independent
                # state file; the GUI publishes its state every 100 ms.
                original_step = runtime.registry.tools["desktop.step"].handler
                async def checked_step(**args):
                    result = await original_step(**args)
                    await wait_state("output", "Received: desktop audit verified")
                    return result
                runtime.registry.tools["desktop.step"].handler = checked_step
                await probe("desktop.step", {"snapshot_id": runtime.snapshot["snapshot_id"], "kind": "click", "point": point("button"), "expected_text": "Received: desktop audit verified"},
                            lambda r: state()["output"] == "Received: desktop audit verified", lambda r: {"status": r.get("status"), "demo_output": state()["output"], "expected_result_verified": r.get("expected_result_verified")})
            report["visible_with_target"] = [t.name for t in runtime.registry.active_tools()]
            if options.computer:
                if options.computer_click_only and typed:
                    await runtime.capture()
                    await original_step(snapshot_id=runtime.snapshot["snapshot_id"], kind="click", point=point("entry"))
                    await runtime.capture()
                    await original_step(snapshot_id=runtime.snapshot["snapshot_id"], kind="key", key="end")
                    await runtime.capture()
                    await original_step(snapshot_id=runtime.snapshot["snapshot_id"], kind="type", text=" click")
                    assert await wait_state("message", "desktop audit verified click")
                await runtime.capture()
                goal = ("只操作这个测试窗口。输入框已经包含 desktop audit verified click，不要改动文字。点击 Apply message 按钮，确认下方显示 Received: desktop audit verified click 后结束。不要打开其他应用。"
                        if options.computer_click_only else
                        "只操作这个测试窗口。在 Your message 输入框中将原内容替换成 computer audit verified，然后点击 Apply message。确认下方显示 Received: computer audit verified 后结束。不要打开其他应用。")
                expected = "Received: desktop audit verified click" if options.computer_click_only else "Received: computer audit verified"
                await probe("computer.run", {"goal": goal},
                            lambda r: r["status"] == "succeeded" and state()["output"] == expected and any(a.get("success") for a in r.get("actions", [])),
                            lambda r: {"status": r["status"], "demo_output": state()["output"], "duration_ms": r.get("duration_ms")})
            else:
                report["checks"].append({"tool": "computer.run", "status": "not_run", "message": "Pass --computer to run the configured model against the owned demo"})
        attempted = {x["tool"] for x in report["checks"]}
        report["not_attempted"] = sorted(set(report["registered"]) - attempted)
        report["summary"] = {s: sum(x["status"] == s for x in report["checks"]) for s in {x["status"] for x in report["checks"]}}
        save()
        print(json.dumps({"report": str(output / "report.json"), "summary": report["summary"], "not_attempted": report["not_attempted"]}, ensure_ascii=False), flush=True)
    finally:
        save()
        await runtime.close()
        if demo and demo.poll() is None:
            demo.terminate()
            await asyncio.to_thread(demo.wait, 5)
        if server:
            await asyncio.to_thread(server.shutdown)
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=ROOT)
    parser.add_argument("--profile", type=Path, default=Path(os.environ.get("APPDATA", str(ROOT))) / "Ayana")
    parser.add_argument("--computer", action="store_true")
    parser.add_argument("--computer-click-only", action="store_true", help="Probe the model's click/verification path without requiring an editable UIA control")
    asyncio.run(audit(parser.parse_args()))
