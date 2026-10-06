"""UFO adapter process. Credentials enter through stdin, never argv or files."""
from __future__ import annotations

import asyncio
import base64
import ctypes
import io
import json
import os
from pathlib import Path
import re
import shutil
import site
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "AYANA_COMPUTER "


def json_object(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


class ControlPlane:
    def __init__(self, emit):
        self.emit = emit
        self.gate = threading.Event()
        self.gate.set()
        self.stopped = threading.Event()
        self.confirmations = {}

    def read(self):
        for line in sys.stdin:
            try:
                value = json.loads(line)
                command = value.get("command")
                if command == "pause":
                    self.gate.clear()
                    self.emit({"type": "paused", "message": "已暂停；不会执行下一步"})
                elif command == "resume":
                    self.gate.set()
                elif command == "cancel":
                    break
                elif command == "confirm" and value.get("approval_id") in self.confirmations:
                    item = self.confirmations[value["approval_id"]]
                    item["accepted"] = value.get("accept") is True
                    item["event"].set()
            except (ValueError, TypeError):
                continue
        self.stopped.set()
        self.gate.set()

    def checkpoint(self):
        while not self.gate.wait(.1):
            if self.stopped.is_set():
                raise RuntimeError("Desktop task cancelled")
        if self.stopped.is_set():
            raise RuntimeError("Desktop task cancelled")

    def confirm(self, description):
        identifier = "computer-approval-" + uuid.uuid4().hex[:12]
        item = {"event": threading.Event(), "accepted": False}
        self.confirmations[identifier] = item
        self.emit({"type": "confirmation", "approval_id": identifier,
                   "message": description[:1000]})
        try:
            while not item["event"].wait(.1):
                if self.stopped.is_set():
                    raise RuntimeError("Desktop task cancelled")
            self.checkpoint()
            return item["accepted"]
        finally:
            self.confirmations.pop(identifier, None)


def main():
    wire = sys.stdout
    wire.reconfigure(encoding="utf-8")
    wire_lock = threading.Lock()
    def emit(value):
        with wire_lock:
            wire.write(PREFIX + json.dumps(value, ensure_ascii=False) + "\n")
            wire.flush()
    # Wait for ownership by the parent's Windows Job before doing anything else.
    emit({"type": "hello", "pid": os.getpid()})
    request = json.loads(sys.stdin.readline())
    home, work = map(lambda p: Path(p).resolve(), sys.argv[1:3])
    root = Path(request["repository_root"]).resolve()
    upstream = home / "upstream"
    log = (work / "worker.log").open("w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log
    sys.path[:0] = [str(home / "site-packages"), str(upstream), str(root)]
    site.addsitedir(str(home / "site-packages"))
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(name, None)
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    # UFO's Excel client pulls in pandas/numpy. Loading numpy's OpenBLAS
    # extension after a socket/select thread (the relay server below) starts
    # deadlocks during DLL initialization on Windows, so warm it first while
    # this process is still single-threaded.
    import numpy  # noqa: F401
    import pandas  # noqa: F401
    control = ControlPlane(emit)
    threading.Thread(target=control.read, daemon=True).start()
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    server = client = None
    try:
        import httpx
        from services.agent.prompts import desktop_goal, template
        from services.agent.prompts.trace import export_body
        import yaml
        from native.windows.win32 import Win32
        api = Win32()
        api.user.GetWindowDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        api.user.GetWindowDpiAwarenessContext.restype = ctypes.c_void_p
        api.user.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        api.user.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
        expected = request["target"]
        metrics, actions = [], []
        captures = {"bounds": None, "after_action": False, "count": 0}
        def target_identity():
            control.checkpoint()
            target = api.identity(expected["hwnd"])
            if any(target[key] != expected[key] for key in ("hwnd", "process_id", "process_created", "class_name")):
                raise RuntimeError("窗口或进程已更换，请重新绑定")
            if target["window_state"] != "visible" or target["elevated"] is not False:
                raise RuntimeError("目标窗口不可见或权限已变化")
            return target
        target_identity()
        emit({"type": "progress", "message": "正在加载桌面执行组件"})
        model = request["model"]
        endpoint = model["base_url"].rstrip("/") + "/chat/completions"
        client = httpx.Client(timeout=httpx.Timeout(60, connect=12), trust_env=False)
        relay_token = uuid.uuid4().hex

        def model_call(body, phase="planning"):
            control.checkpoint()
            target_identity()
            body.update(model=model["name"], max_tokens=4096, stream=False,
                        temperature=.2, top_p=1)
            if "deepseek" in model["base_url"].lower():
                body["thinking"] = {"type": "disabled"}
            emit({"type": "prompt.request", "phase": "desktop_" + phase, "body": export_body(body)})
            started = time.monotonic()
            response = client.post(endpoint, json=body, headers={"Authorization": "Bearer " + model["key"]})
            metrics.append({"status": response.status_code, "phase": phase,
                            "duration_ms": round((time.monotonic()-started)*1000),
                            "usage": response.json().get("usage") if response.status_code == 200 else None})
            control.checkpoint()
            return response

        class Relay(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                try:
                    if self.headers.get("Authorization") != "Bearer " + relay_token:
                        self.reply(401, {"error": {"message": "Invalid local token"}})
                        return
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 16 * 1024 * 1024:
                        self.reply(413, {"error": {"message": "Request is too large"}})
                        return
                    body = json.loads(self.rfile.read(size))
                    # UFO probes structured output unconditionally. This configured
                    # provider does not support it; preserve its normal text fallback.
                    if "deepseek" in model["base_url"].lower() and body.get("response_format", {}).get("type") == "json_schema":
                        self.reply(400, {"error": {"message": "'response_format' of type 'json_schema' is not supported", "type": "invalid_request_error"}})
                        return
                    response = model_call(body)
                    if response.status_code == 200:
                        try:
                            value = json_object(response.json()["choices"][0]["message"]["content"])
                            emit({"type": "model", "message": str(value.get("Comment", value.get("comment", "正在分析当前窗口")))[:500],
                                  "status": value.get("Status", value.get("status")), "usage": response.json().get("usage")})
                        except (ValueError, KeyError, TypeError):
                            pass
                    self.reply(response.status_code, response.content)
                except Exception:
                    self.reply(502, {"error": {"message": "桌面模型请求失败", "type": "relay_error"}})
            def reply(self, status, payload):
                content = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                with __import__("contextlib").suppress(BrokenPipeError, ConnectionResetError):
                    self.wfile.write(content)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        # Copy every config module: UFO loads "ufo" and "galaxy" from the
        # working directory, and galaxy is pulled in lazily while a session
        # starts. Only "ufo" is rewritten below.
        shutil.copytree(upstream / "config", work / "config")
        # Prompt paths default to schema values like "ufo/prompts/...", resolved
        # against the working directory, so stage the prompts there too.
        shutil.copytree(upstream / "ufo/prompts", work / "ufo/prompts")
        config_path = work / "config/ufo"
        def absolute_paths(value):
            if isinstance(value, dict):
                return {k: absolute_paths(v) for k, v in value.items()}
            if isinstance(value, list):
                return [absolute_paths(v) for v in value]
            if isinstance(value, str) and value.startswith("ufo/"):
                return str(upstream / value)
            return value
        for path in config_path.glob("*.yaml"):
            value = absolute_paths(yaml.safe_load(path.read_text(encoding="utf-8")))
            path.write_text(yaml.safe_dump(value), encoding="utf-8")
        agents = yaml.safe_load((upstream / "config/ufo/agents.yaml.template").read_text(encoding="utf-8"))
        for name in ("HOST_AGENT", "APP_AGENT", "BACKUP_AGENT", "EVALUATION_AGENT"):
            agents[name].update(API_TYPE="openai", API_BASE=f"http://127.0.0.1:{server.server_port}/v1",
                                API_KEY=relay_token, API_MODEL=model["name"], VISUAL_MODE=True,
                                REASONING_MODEL=False, USE_RESPONSES=False)
        # The template is merged after the rewrite loop above, so its relative
        # "ufo/..." prompt paths need the same absolute rewrite here.
        agents = absolute_paths(agents)
        (config_path / "agents.yaml").write_text(yaml.safe_dump(agents), encoding="utf-8")
        system_path = config_path / "system.yaml"
        system = yaml.safe_load(system_path.read_text(encoding="utf-8"))
        system.update(MAX_STEP=request["max_steps"], MAX_ROUND=1, MAX_RETRY=1,
                      JSON_PARSING_RETRY=1, TIMEOUT=60, EVA_SESSION=False, EVA_ROUND=False,
                      SAVE_FULL_SCREEN=False, SAVE_UI_TREE=False, ENABLED_THIRD_PARTY_AGENTS=[],
                      SAVE_EXPERIENCE="always_not", PRINT_LOG=False, INPUT_TEXT_API="set_text",
                      CONTROL_BACKEND=["uia"], CONTROL_FILTER_TYPE=[], TOP_P=1, ASK_QUESTION=False,
                      SAFE_GUARD=True, SLEEP_TIME=.1)
        system["CONTROL_LIST"] = ["Button", "Edit", "Text", "Document", "ComboBox", "CheckBox",
                                  "RadioButton", "TabItem", "ListItem", "MenuItem", "ScrollBar",
                                  "TreeItem", "Hyperlink", "Spinner", "Group"]
        system_path.write_text(yaml.safe_dump(system), encoding="utf-8")
        mcp = {"HostAgent": {"default": {"data_collection": [{"namespace": "UICollector", "type": "local"}],
                                         "action": [{"namespace": "HostUIExecutor", "type": "local"}]}},
               "AppAgent": {"default": {"data_collection": [{"namespace": "UICollector", "type": "local"}],
                                        "action": [{"namespace": "AppUIExecutor", "type": "local"}]}}}
        (config_path / "mcp.yaml").write_text(yaml.safe_dump(mcp), encoding="utf-8")
        os.chdir(work)
        from pywinauto import Desktop
        from ufo.llm.openai import OpenAIService
        from openai import OpenAI
        from ufo.automator.ui_control.inspector import ControlInspectorFacade
        from ufo.automator.ui_control.screenshot import PhotographerFacade, _win32_print_window, Photographer
        from ufo.automator.action_execution import ActionExecutor
        from ufo.module import interactor
        window = Desktop(backend="uia").window(handle=expected["hwnd"]).wrapper_object()
        if not api.focus(expected["hwnd"]):
            raise RuntimeError("无法激活目标窗口，请将目标窗口置于前台后重试")
        def local_client(api_type, api_base, max_retry, timeout, api_key=None, *args, **kwargs):
            if not api_base.startswith(f"http://127.0.0.1:{server.server_port}/"):
                raise RuntimeError("Unexpected model endpoint")
            return OpenAI(base_url=api_base, api_key=api_key, max_retries=max_retry,
                          timeout=timeout, http_client=httpx.Client(trust_env=False))
        OpenAIService.get_openai_client = staticmethod(local_client)
        ControlInspectorFacade.get_desktop_windows = lambda self, remove_empty=True: [window]
        original_find = ControlInspectorFacade.find_control_elements_in_descendants
        def scoped_controls(self, parent, control_type_list=[], class_name_list=[], title_list=[],
                            is_visible=True, is_enabled=True, depth=0):
            target_identity()
            if parent.handle != expected["hwnd"]:
                raise RuntimeError("Control enumeration outside bound window")
            found = original_find(self, parent, control_type_list, class_name_list, title_list, is_visible, is_enabled, depth)
            if not any(c.element_info.control_type in {"Edit", "Document"} for c in found):
                native = Desktop(backend="win32").window(handle=parent.handle).wrapper_object()
                existing = {tuple(c.element_info.runtime_id or []) for c in found}
                for child in native.descendants():
                    try:
                        candidate = Desktop(backend="uia").window(handle=child.handle).wrapper_object()
                        identity = tuple(candidate.element_info.runtime_id or [])
                        if identity not in existing:
                            found.append(candidate)
                            existing.add(identity)
                    except Exception:
                        pass
            return [c for c in found if c.process_id() == expected["process_id"]
                    and (not control_type_list or c.element_info.control_type in control_type_list)
                    and (not is_visible or c.is_visible()) and (not is_enabled or c.is_enabled())
                    and (not title_list or c.window_text() in title_list)][:120]
        ControlInspectorFacade.find_control_elements_in_descendants = scoped_controls
        def capture(self, selected, save_path=None, scalar=None):
            current = target_identity()
            if selected.handle != expected["hwnd"] or selected.process_id() != expected["process_id"]:
                raise RuntimeError("Screenshot outside bound window")
            bounds = current["bounds"]
            size = (bounds["right"]-bounds["left"], bounds["bottom"]-bounds["top"])
            awareness = api.user.GetAwarenessFromDpiAwarenessContext(api.user.GetWindowDpiAwarenessContext(selected.handle))
            previous = api.user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-1 if awareness == 0 else -4))
            try:
                picture = _win32_print_window(selected.handle)
            finally:
                api.user.SetThreadDpiAwarenessContext(previous)
            if picture is None or picture.getbbox() is None:
                raise RuntimeError("目标窗口截图为空，无法继续")
            if target_identity()["bounds"] != bounds:
                raise RuntimeError("窗口在截图期间移动，请重新观察")
            picture = picture.resize(size)
            if size[0] * size[1] > 8_000_000:
                # A high-DPI window can exceed the model image budget. UFO uses
                # normalized coordinates and named controls, so shrinking the
                # screenshot keeps observations bounded without moving clicks.
                from PIL import Image
                factor = (8_000_000 / (size[0] * size[1])) ** .5
                picture = picture.resize((max(1, round(picture.width*factor)), max(1, round(picture.height*factor))), Image.LANCZOS)
            captures.update(bounds=bounds, count=captures["count"]+1, after_action=bool(actions))
            if scalar is not None:
                picture = Photographer.rescale_image(picture, scalar)
            if save_path is not None:
                picture.save(save_path)
            return picture
        PhotographerFacade.capture_app_window_screenshot = capture
        PhotographerFacade.capture_desktop_screen_screenshot = lambda self, all_screens=True, save_path=None: capture(self, window, save_path)
        photographer = PhotographerFacade()
        before = capture(photographer, window, str(work / "before.png"))
        original_execute = ActionExecutor.execute
        action_lock = threading.Lock()
        allowed = {"click_input", "click_on_coordinates", "set_edit_text", "keyboard_input", "wheel_mouse_input", "texts", "summary"}
        approved_sensitive = {"next": False}
        sensitive = re.compile(r"发送|提交|删除|付款|购买|授权|\b(send|submit|delete|purchase|pay|authorize)\b", re.I)
        def execute(self, action, puppeteer, control_dict, application_window=None):
            with action_lock:
                current = target_identity()
                if not application_window or application_window.handle != expected["hwnd"] or application_window.process_id() != expected["process_id"]:
                    raise RuntimeError("Action outside bound window")
                if action.function not in allowed:
                    raise RuntimeError("Unsupported desktop action")
                if len(actions) >= request["max_actions"]:
                    raise RuntimeError("桌面操作次数已用完")
                selected = control_dict.get(action.target.id) if action.target and action.target.id else None
                if action.target and action.target.id and (selected is None or selected.process_id() != expected["process_id"] or selected.window_text() != action.target.name):
                    raise RuntimeError("控件名称或身份已变化，请重新观察")
                if captures["bounds"] != current["bounds"]:
                    raise RuntimeError("窗口已移动，请重新观察后再执行")
                if action.function == "keyboard_input":
                    keys = action.arguments.get("keys", "")
                    if not re.fullmatch(r"(?:(?:\{(?:TAB|ENTER|ESC|ESCAPE|BACKSPACE|DELETE|HOME|END|LEFT|RIGHT|UP|DOWN|PGUP|PGDN|VK_NEXT|VK_PRIOR)\})|(?:\^[acvz])){1,12}", keys, re.I):
                        raise RuntimeError("普通文本请通过输入框 set_edit_text 写入，以保留中文和空格")
                if action.function == "set_edit_text":
                    if not selected or len(action.arguments.get("text", "")) > 4000:
                        raise RuntimeError("输入框或文本长度无效")
                mutates = action.function not in {"texts", "summary"}
                if mutates:
                    if sensitive.search(action.target.name if action.target else "") and not approved_sensitive["next"]:
                        if not control.confirm(f"在“{current['title']}”中执行 {action.function}：{action.target.name}"):
                            emit({"type": "fatal", "code": "approval_rejected", "message": "你拒绝了这一步，桌面任务已停止"})
                            raise RuntimeError("用户拒绝了这一步，请停止任务")
                    approved_sensitive["next"] = False
                    control.checkpoint()
                    target_identity()
                    if api.foreground() != expected["hwnd"]:
                        # A user switching to another app takes ownership of input.
                        emit({"type": "fatal", "code": "user_takeover", "message": "前台窗口已切换，桌面任务已停止"})
                        raise RuntimeError("用户已接管前台窗口")
                    if action.function == "click_on_coordinates":
                        x, y = action.arguments.get("x"), action.arguments.get("y")
                        if type(x) not in (int, float) or type(y) not in (int, float) or not 0 <= x <= 1 or not 0 <= y <= 1:
                            raise RuntimeError("点击坐标无效")
                        bounds = current["bounds"]
                        px, py = bounds["left"]+round(x*(bounds["right"]-bounds["left"])), bounds["top"]+round(y*(bounds["bottom"]-bounds["top"]))
                        if api.point_root(px, py) != expected["hwnd"]:
                            raise RuntimeError("点击位置被其他窗口遮挡")
                    elif action.function == "click_input" and selected:
                        rectangle = selected.rectangle()
                        if api.point_root((rectangle.left+rectangle.right)//2, (rectangle.top+rectangle.bottom)//2) != expected["hwnd"]:
                            raise RuntimeError("目标控件被其他窗口遮挡")
                record = {"function": action.function, "arguments": action.arguments,
                          "target": action.target.model_dump() if action.target else None, "success": False}
                actions.append(record)
                emit({"type": "action", "message": f"执行 {action.function}：{action.target.name if action.target else ''}", "action": record})
                result = original_execute(self, action, puppeteer, control_dict, application_window)
                if isinstance(result, str) and (result.startswith("An error occurred") or result.startswith("Failed")):
                    raise RuntimeError(result[:300])
                if action.function == "set_edit_text":
                    try:
                        actual = selected.get_value()
                    except Exception:
                        actual = selected.window_text()
                    if actual != action.arguments["text"]:
                        raise RuntimeError("实际输入内容不匹配，不能报告成功")
                record["success"] = True
                captures["after_action"] = False
                emit({"type": "action_done", "message": "操作已执行，继续核实窗口", "action": record})
                return result
        ActionExecutor.execute = execute
        interactor.new_request = lambda: ("", True)
        def sensitive_step(action, name):
            approved = control.confirm(f"下一步：{action}；目标：{name}")
            if not approved:
                emit({"type": "fatal", "code": "approval_rejected", "message": "你拒绝了这一步，桌面任务已停止"})
            approved_sensitive["next"] = approved
            return approved
        interactor.sensitive_step_asker = sensitive_step
        def no_terminal_question(*args, **kwargs):
            emit({"type": "fatal", "code": "computer_needs_input", "message": "任务需要补充信息，请取消后补充任务描述"})
            raise RuntimeError("Interactive terminal input is unavailable")
        interactor.question_asker = no_terminal_question
        import ufo.agents.agent.basic as basic_agent
        basic_agent.question_asker = no_terminal_question
        from ufo.module.sessions.session import Session
        goal = desktop_goal(expected["title"], request["goal"])
        emit({"type": "progress", "message": "正在观察目标窗口并规划操作"})
        session = Session(task=request["run_id"], should_evaluate=False, id=0, request=goal)
        asyncio.run(session.run())
        control.checkpoint()
        after = capture(photographer, window, str(work / "after.png"))
        evidence = []
        for item in scoped_controls(ControlInspectorFacade("uia"), window, is_enabled=False):
            row = {"name": item.window_text(), "type": item.element_info.control_type}
            if item.handle:
                text_buffer = ctypes.create_unicode_buffer(4096)
                api.user.GetWindowTextW(item.handle, text_buffer, len(text_buffer))
                row["native_text"] = text_buffer.value
            try:
                row["value"] = item.get_value()
            except Exception:
                pass
            try:
                row["checked"] = item.get_toggle_state()
            except Exception:
                pass
            evidence.append(row)
        def encoded(picture):
            buffer = io.BytesIO()
            picture.save(buffer, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
        emit({"type": "progress", "message": "正在独立核实最终界面"})
        verification = {"status": "needs_verification", "reason": "最终结果尚未核实", "evidence": []}
        response = model_call({"messages": [
            {"role": "system", "content": template("desktop-verification.md")},
            {"role": "user", "content": [{"type": "text", "text": json.dumps({"goal": request["goal"], "final_controls": evidence, "actions": actions}, ensure_ascii=False)},
                                          {"type": "image_url", "image_url": {"url": encoded(before)}},
                                          {"type": "image_url", "image_url": {"url": encoded(after)}}]}]}, phase="verification")
        if response.status_code == 200:
            verification = json_object(response.json()["choices"][0]["message"]["content"])
        status = verification.get("status")
        if status not in {"succeeded", "failed", "needs_verification"}:
            status = "needs_verification"
        if session._host_agent.status != "FINISH" or any(not a["success"] for a in actions) or session.step >= request["max_steps"]:
            status = "failed"
        result = {"status": status, "reason": str(verification.get("reason", "结果尚待核实"))[:1000],
                  "evidence": verification.get("evidence", [])[:12], "actions": actions,
                  "steps": session.step, "controls": evidence, "model_requests": metrics,
                  "target": target_identity(), "upstream_commit": "a795552d976c4c019d7c2f778a0effb5cef7de6b"}
        emit({"type": "result", "result": result})
        return 0
    except Exception as error:
        import traceback
        traceback.print_exc(file=log)
        emit({"type": "fatal", "code": "computer_failed", "message": str(error)[:400] if isinstance(error, (ValueError, RuntimeError)) else "桌面任务执行失败，请查看本机记录"})
        return 1
    finally:
        if server:
            server.shutdown()
        if client:
            client.close()
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())
