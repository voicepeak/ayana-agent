"""Real-model regression of Ayana's desktop-task entry and lifecycle."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime


class SilentTts:
    status = {"state": "ready", "engine": "silent"}
    async def start(self): pass
    async def cancel(self, generation): pass
    async def close(self): pass


class Recorder:
    def __init__(self):
        self.events = []
    async def send_json(self, value):
        self.events.append(value)


async def wait_until(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > deadline:
            raise TimeoutError("Regression condition timed out")
        await asyncio.sleep(.05)


async def main():
    if os.name != "nt":
        raise RuntimeError("Windows is required")
    home = ROOT / ".runtime/benchmarks/computer-use-product" / str(round(time.time()*1000))
    home.mkdir(parents=True)
    state_path = home / "fixture.json"
    fixture = subprocess.Popen(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File",
                                str(ROOT / "scripts/fixtures/computer_use.ps1"), "-StatePath", str(state_path)],
                               creationflags=0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    runtime = None
    cases = []
    def state():
        return json.loads(state_path.read_text(encoding="utf-8"))
    try:
        await wait_until(state_path.exists)
        await asyncio.sleep(.3)
        assert state()["process_id"] == fixture.pid
        configured = Settings()
        settings = Settings(ROOT, home / "data")
        settings.values = dict(configured.values)
        settings.values.update(save_history=True, voice={"voice_mode": "silent"})
        settings.key = configured.key
        runtime = AgentRuntime(settings, tts=SilentTts())
        recorder = Recorder()
        runtime.clients.add(recorder)
        await runtime.handle({"type": "mode.set", "mode": "execute"})
        await runtime.handle({"type": "target.bind", "hwnd": state()["hwnd"]})
        await runtime.handle({"type": "capabilities.get"})
        assert recorder.events[-1]["type"] == "capabilities.ready"
        assert recorder.events[-1]["computer_use"]["available"]
        for name, text in [("unicode", "你好，Ayana！中文 + English 123，空格 保留。"),
                           ("moved_and_option", "移动窗口后：精确 保留 空格！")]:
            before = state()
            if name == "moved_and_option":
                from native.windows.win32 import Win32
                api = Win32()
                import ctypes
                api.user.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
                api.user.SetWindowPos(before["hwnd"], None, 600, 100, 0, 0, 0x0001 | 0x0004)
            goal = f'将 Message input 的内容完整替换为“{text}”，'
            if name == "moved_and_option":
                goal += '勾选 Enable option，'
            goal += f'然后点击 Apply message 一次；核实 Result 显示“Received: {text}”。'
            started = time.monotonic()
            await runtime.handle({"type": "computer.start", "goal": goal})
            current = runtime.task
            if name == "unicode":
                await wait_until(lambda: any(e["type"] == "computer.progress" for e in recorder.events))
                await runtime.handle({"type": "task.pause"})
                await wait_until(lambda: any(e["type"] == "computer.progress" and e["progress"]["type"] == "paused" for e in recorder.events))
                paused = state()
                await asyncio.sleep(.8)
                assert state()["message"] == paused["message"] and state()["apply_count"] == paused["apply_count"]
                await runtime.handle({"type": "task.resume"})
            await asyncio.wait_for(current, 180)
            observed = state()
            result_events = [e for e in recorder.events if e["type"] == "computer.completed"]
            passed = (runtime.active_task.state == "succeeded" and observed["message"] == text
                      and observed["output"] == "Received: " + text and observed["apply_count"] == before["apply_count"]+1
                      and (name != "moved_and_option" or observed["option_enabled"]))
            row = {"name": name, "passed": passed, "state": runtime.active_task.state,
                   "duration_ms": round((time.monotonic()-started)*1000), "observed": observed,
                   "result": result_events[-1]["result"] if result_events else None,
                   "errors": [e.get("message") for e in recorder.events if e["type"] == "error"]}
            cases.append(row)
            print(json.dumps({k: row[k] for k in ("name", "passed", "state", "duration_ms", "errors")}, ensure_ascii=False), flush=True)
            if not passed:
                raise AssertionError("Desktop task did not meet its independent oracle")
            recorder.events.clear()
        # Stop an in-flight model task, then verify there are no late writes.
        before = state()
        await runtime.handle({"type": "computer.start", "goal": "把 Message input 替换为取消任务不应出现，然后点击 Apply message。"})
        await wait_until(lambda: any(e["type"] == "computer.progress" for e in recorder.events))
        await runtime.handle({"type": "task.cancel"})
        await asyncio.sleep(.8)
        observed = state()
        cancelled = (runtime.active_task.state == "cancelled" and runtime.computer.process is None
                     and observed["message"] == before["message"] and observed["apply_count"] == before["apply_count"])
        cases.append({"name": "cancel_no_late_writes", "passed": cancelled})
        assert cancelled
    finally:
        if runtime:
            await runtime.close()
        if state_path.exists():
            from native.windows.win32 import Win32
            api = Win32()
            import ctypes
            owned = state()
            if api.identity(owned["hwnd"])["process_id"] == fixture.pid:
                api.user.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
                api.user.PostMessageW(owned["hwnd"], 0x0010, 0, 0)
        fixture.wait(timeout=5)
        report = {"passed": bool(cases) and all(c["passed"] for c in cases), "cases": cases}
        (home / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("Report:", home / "report.json", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
