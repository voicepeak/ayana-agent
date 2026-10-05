"""Discover installed applications and open authorized local resources."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
import httpx

from .policy import check_plain
from .registry import ToolError
from .formats import is_text, is_openable
from .filesystem import FileBrowser


def app_record(name, target, aliases=(), parameters=None, source="应用"):
    key = json.dumps([str(target).casefold(), parameters], ensure_ascii=False)
    return {"app_id": "app-" + hashlib.sha256(key.encode()).hexdigest()[:16], "name": name,
            "target": str(target), "aliases": list(aliases), "parameters": parameters, "source": source}


def resolve_shortcut(path):
    """Resolve only a catalog-discovered link; its path is data, not PS source."""
    check_plain(Path(path))
    if os.name != "nt":
        raise ToolError("platform_unavailable", "快捷方式解析仅支持 Windows")
    powershell = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = ("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "
              "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AYANA_DOCUMENT_SHORTCUT); "
              "@{target=$s.TargetPath;parameters=$s.Arguments} | ConvertTo-Json -Compress")
    try:
        completed = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
                                   env={**os.environ, "AYANA_DOCUMENT_SHORTCUT": str(path)},
                                   capture_output=True, timeout=8, creationflags=subprocess.CREATE_NO_WINDOW)
        if completed.returncode or len(completed.stdout) > 16384:
            raise ValueError("shortcut resolution failed")
        value = json.loads(completed.stdout.decode("utf-8-sig"))
        target = Path(value["target"])
        if not target.is_absolute() or target.suffix.lower() != ".exe":
            raise ValueError("not an executable shortcut")
        return str(target), value.get("parameters") or None
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        raise ToolError("unsupported_document_app", "无法解析该应用入口；可使用桌面工具打开文件") from None


def discover_apps():
    if os.name != "nt":
        return []
    system = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"
    result = []
    for executable, name, aliases in [
        ("notepad.exe", "记事本", ["notepad", "notepad.exe"]),
        ("calc.exe", "计算器", ["calculator", "calc"]),
        ("mspaint.exe", "画图", ["paint", "mspaint"]),
        ("explorer.exe", "文件资源管理器", ["explorer", "资源管理器"]),
        ("control.exe", "控制面板", ["control panel"]),
    ]:
        target = (system.parent if executable == "explorer.exe" else system) / executable
        if target.is_file():
            result.append(app_record(name, target, aliases, source="Windows"))
    result.append(app_record("Windows 设置", "ms-settings:", ["设置", "settings"], source="Windows"))
    # Registered executable paths cover applications without Start Menu shortcuts.
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths", 0, winreg.KEY_READ | view) as key:
                    for index in range(min(winreg.QueryInfoKey(key)[0], 1000)):
                        name = winreg.EnumKey(key, index)
                        if not name.lower().endswith(".exe"):
                            continue
                        try:
                            with winreg.OpenKey(key, name) as child:
                                value = winreg.QueryValueEx(child, None)[0]
                            target = Path(os.path.expandvars(value.strip().strip('"')))
                            if target.is_absolute() and target.is_file() and target.suffix.lower() == ".exe":
                                result.append(app_record(Path(name).stem, target, [name], source="已注册应用"))
                        except (OSError, TypeError, AttributeError):
                            pass
            except OSError:
                pass
    # Links are selected from server-discovered Start Menu locations, never model paths.
    for base in (os.environ.get("APPDATA"), os.environ.get("ProgramData")):
        if not base:
            continue
        root = Path(base) / "Microsoft/Windows/Start Menu/Programs"
        if not root.is_dir():
            continue
        visited = 0
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if not Path(directory, name).is_symlink()]
            for name in names:
                visited += 1
                if visited > 2000:
                    dirs[:] = []
                    break
                path = Path(directory, name)
                if path.suffix.lower() != ".lnk" or any(word in name.casefold() for word in ("uninstall", "卸载")):
                    continue
                try:
                    check_plain(path)
                    result.append(app_record(path.stem, path, source="开始菜单"))
                except (ToolError, OSError):
                    pass
            if visited > 2000:
                break
    # Microsoft Store applications have AppUserModelIDs instead of executable paths.
    try:
        powershell = system / "WindowsPowerShell/v1.0/powershell.exe"
        completed = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command",
                                    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"],
                                   capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        if completed.returncode == 0 and len(completed.stdout) <= 2 * 1024 * 1024:
            items = json.loads(completed.stdout.decode("utf-8-sig"))
            for item in (items if isinstance(items, list) else [items])[:1000]:
                app_id = item.get("AppID", "")
                if "!" in app_id and re.fullmatch(r"[A-Za-z0-9._!{}-]{1,300}", app_id):
                    result.append(app_record(str(item["Name"])[:300], system.parent / "explorer.exe", parameters="shell:AppsFolder\\" + app_id, source="Microsoft Store"))
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError):
        pass
    return result


class ApplicationCatalog:
    def __init__(self, discover=discover_apps):
        self.discover = discover
        self.items = {}
        self.updated = None
        self.lock = threading.RLock()

    def refresh(self):
        if self.updated is None or time.monotonic() - self.updated > 60:
            self.items = {item["app_id"]: item for item in reversed(self.discover())}
            self.updated = time.monotonic()

    def search(self, query, limit=10):
        with self.lock:
            self.refresh()
            query = query.strip().casefold()
            matches = []
            for item in self.items.values():
                names = [item["name"].casefold(), *(alias.casefold() for alias in item["aliases"])]
                score = 2 if query in names else 1 if any(query in name for name in names) else 0
                if score:
                    matches.append((score, item))
            matches.sort(key=lambda pair: (-pair[0], pair[1]["source"] != "Windows", pair[1]["name"].casefold()))
            if matches and matches[0][0] == 2:
                matches = [pair for pair in matches if pair[0] == 2]
            result, seen = [], set()
            for _, item in matches:
                name = item["name"].casefold()
                if name in seen:
                    continue
                seen.add(name)
                result.append({key: item[key] for key in ("app_id", "name", "source")})
                if len(result) == limit:
                    break
            return result

    def get(self, app_id):
        with self.lock:
            self.refresh()
            if app_id not in self.items:
                raise ToolError("unknown_app", "应用 ID 不存在，请先查找已安装应用")
            return dict(self.items[app_id])


class SystemTools:
    def __init__(self, policy, opener=None, catalog=None, shortcut_resolver=None):
        if opener is None:
            from native.windows.shell import open_target
            opener = open_target
        self.policy, self.opener = policy, opener
        self.browser = FileBrowser(policy)
        self.apps = catalog or ApplicationCatalog()
        self.shortcut_resolver = shortcut_resolver or resolve_shortcut

    def open_app(self, app_id, cancelled):
        app = self.apps.get(app_id)
        target = app["target"]
        if not target.startswith("ms-settings:"):
            path = Path(target)
            check_plain(path)
            if not path.is_file():
                raise ToolError("app_missing", "该应用入口已不存在，请刷新应用列表")
        result = self.opener(target, app["parameters"], cancelled)
        return {**result, "app_id": app_id, "name": app["name"], "kind": "application",
                "executable_name": Path(target).name if Path(target).suffix.lower() == ".exe" and not app["parameters"] else None}

    def list_files(self, root_id, path="", limit=100, recursive=False, text_only=False):
        return self.browser.list(root_id, path, limit, recursive, text_only)

    def find_files(self, root_id, query, path="", limit=30):
        return self.browser.find(root_id, query, path, limit)

    def open_file(self, root_id, path, cancelled, app_id=None):
        target = self.policy.resolve(root_id, path, allow_root=True)
        if not target.exists():
            raise ToolError("file_missing", "要打开的文件或目录不存在")
        is_directory = target.is_dir()
        if not is_directory and not is_openable(target):
            raise ToolError("unsupported_open", "仅支持文本、文档、图片、影音和目录；启动应用请使用 apps.open")
        app = None
        if app_id:
            app = self.apps.get(app_id)
            executable, parameters = app["target"], app["parameters"]
            if Path(executable).suffix.lower() == ".lnk":
                executable, parameters = self.shortcut_resolver(executable)
            executable = Path(executable)
            check_plain(executable)
            # Document launch adapters accept a file path, never model-supplied
            # arguments. Unknown apps can still use the bound-window UI tools.
            adapters = {"code.exe": ["--reuse-window", "--"], "code - insiders.exe": ["--reuse-window", "--"],
                        "notepad.exe": [], "notepad++.exe": [], "wordpad.exe": [],
                        "winword.exe": [], "excel.exe": [], "powerpnt.exe": [], "soffice.exe": [],
                        "acrobat.exe": [], "acrord32.exe": [], "sumatrapdf.exe": [], "mspaint.exe": []}
            if parameters or executable.name.lower() not in adapters or not executable.is_file():
                raise ToolError("unsupported_document_app", "该应用暂不支持直接打开文档参数；可选择应用窗口后用桌面工具打开指定文件")
            arguments = [*adapters[executable.name.lower()], str(target)]
            result = self.opener(str(executable), subprocess.list2cmdline(arguments), cancelled)
            app = {"app_id": app_id, "application": app["name"], "executable_name": executable.name}
        elif not is_directory and is_text(target):
            # Opening source through its file association can execute it.
            notepad = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/notepad.exe"
            result = self.opener(str(notepad), subprocess.list2cmdline([str(target)]), cancelled)
        else:
            result = self.opener(str(target), None, cancelled)
        return {**result, "kind": "directory" if is_directory else "file", "root_id": root_id, "path": path,
                "absolute_path": str(target), **(app or {})}

    def open_url(self, url, cancelled):
        if not isinstance(url, str) or len(url) > 3000 or any(ord(character) < 32 for character in url):
            raise ToolError("invalid_url", "网址无效")
        try:
            parsed = httpx.URL(url)
            if parsed.scheme not in {"http", "https"} or not parsed.host or parsed.username or parsed.password:
                raise ValueError()
        except (ValueError, httpx.InvalidURL):
            raise ToolError("invalid_url", "只能打开不含凭据的 HTTP/HTTPS 网址") from None
        # Browser launch may open the user's local development site. It does not
        # fetch its contents into the backend; web.fetch retains the public-only policy.
        url = str(parsed)
        return {**self.opener(url, None, cancelled), "kind": "url", "url": url}
