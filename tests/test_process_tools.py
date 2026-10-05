import asyncio
import os
from pathlib import Path
import sys
import httpx
import pytest
from services.agent.tools.processes import ProcessTools
from services.agent.tools.registry import ToolError
from services.agent.work import usable_result
from tests.test_full_access import runtime_for, activate


def quoted(value):
    if os.name == "nt":
        return "'" + str(value).replace("'", "''") + "'"
    import shlex
    return shlex.quote(str(value))


def command(script):
    return ("& " if os.name == "nt" else "") + quoted(sys.executable) + " -u " + quoted(script)


@pytest.mark.asyncio
async def test_real_service_incremental_logs_reuse_and_tree_stop(tmp_path):
    script = tmp_path / "server.py"
    script.write_text("from http.server import HTTPServer, BaseHTTPRequestHandler\n"
                      "class Handler(BaseHTTPRequestHandler):\n"
                      " def do_GET(self):\n"
                      "  self.send_response(200); self.end_headers(); self.wfile.write(b'confirmed service')\n"
                      "server = HTTPServer(('127.0.0.1', 0), Handler)\n"
                      "print('PORT=' + str(server.server_port), flush=True)\n"
                      "server.serve_forever()\n")
    manager = ProcessTools(lambda: True)
    try:
        started = await manager.start(command(script), str(tmp_path))
        pid = started["process_id"]
        assert (await manager.start(command(script), str(tmp_path)))["reused"]
        for _ in range(100):
            status = manager.status(pid)
            text = "".join(entry["text"] for entry in status["logs"])
            if "PORT=" in text:
                break
            await asyncio.sleep(.05)
        port = int(text.split("PORT=")[1].splitlines()[0])
        cursor = status["next_log_cursor"]
        assert manager.status(pid, cursor)["logs"] == []
        async with httpx.AsyncClient(trust_env=False) as client:
            assert (await client.get(f"http://127.0.0.1:{port}")).text == "confirmed service"
        stopped = await manager.stop(pid)
        assert stopped["status"] == "stopped" and usable_result({"result": stopped})
        async with httpx.AsyncClient(trust_env=False) as client:
            with pytest.raises((httpx.ConnectError, httpx.ConnectTimeout)):
                await client.get(f"http://127.0.0.1:{port}", timeout=1)
        assert (await manager.stop(pid))["status"] == "stopped"
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_log_ring_reports_loss_and_failed_exit(tmp_path):
    script = tmp_path / "logs.py"
    script.write_text("print('中文😀' * 40000, flush=True)\nraise SystemExit(7)\n", encoding="utf-8")
    manager = ProcessTools(lambda: True)
    try:
        pid = (await manager.start(command(script), str(tmp_path)))["process_id"]
        await asyncio.wait_for(manager.entries[pid]["done"], 10)
        status = manager.status(pid)
        assert status["status"] == "failed" and status["exit_code"] == 7
        assert status["logs_truncated"] and status["has_more_logs"]
        assert manager.entries[pid]["log_size"] <= 65536
        assert "�" not in "".join(item["text"] for item in status["logs"])
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_runtime_preserves_process_on_followup_and_cleans_on_access_change(tmp_path):
    runtime = runtime_for(tmp_path)
    activate(runtime)
    script = tmp_path / "waiting.py"
    script.write_text("import time\nprint('ready', flush=True)\ntime.sleep(60)\n")
    try:
        value = await runtime._process_start(command(script), str(tmp_path))
        pid = value["process_id"]
        await runtime.cancel("new_turn")
        assert runtime.processes.status(pid)["status"] == "running"
        await runtime.handle({"type": "settings.update", "settings": {"full_access": False}})
        assert runtime.processes.entries[pid]["done"].done()
        assert runtime.processes.entries[pid]["process"].returncode is not None
        with pytest.raises(ToolError):
            runtime.processes.status(pid)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_immediate_stop_and_unknown_id_never_target_external_processes(tmp_path):
    manager = ProcessTools(lambda: True)
    try:
        pid = (await manager.start("echo ready", str(tmp_path)))["process_id"]
        assert (await manager.stop(pid))["status"] in {"stopped", "exited"}
        with pytest.raises(ToolError, match="记录不存在"):
            await manager.stop("1234")
    finally:
        await manager.close()
