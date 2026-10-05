"""Verify native app opening with an owned WinForms executable, optionally a real model."""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from native.windows.desktop import WindowsDesktop
from native.windows.win32 import Win32
from services.agent.config import Settings
from services.agent.runtime import AgentRuntime
from services.agent.tasks import TaskRunner
from services.agent.tools.system import ApplicationCatalog, SystemTools, app_record


class SilentTts:
    state = {'state': 'ready', 'engine': 'silent'}
    async def start(self): pass
    async def close(self): pass
    async def cancel(self, generation): pass
    async def synthesize(self, speech, generation):
        return {'engine': 'silent', 'duration_ms': 0, 'pcm_base64': ''}


async def main(live_model):
    directory = ROOT / '.runtime/benchmarks/system-open' / str(time.time_ns())
    directory.mkdir(parents=True)
    executable = directory / 'AyanaOpenProbe.exe'
    source = directory / 'Probe.cs'
    source.write_text('''using System; using System.Windows.Forms;
class Probe { [STAThread] static void Main() { Application.EnableVisualStyles();
Application.Run(new Form { Text="Ayana Open Probe", Width=480, Height=300 }); } }
''', encoding='utf-8')
    compiler = Path(os.environ['SystemRoot']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    subprocess.run([str(compiler), '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll',
                    '/reference:System.Drawing.dll', '/out:' + str(executable), str(source)],
                   check=True, creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True, timeout=30)
    profile = Settings()
    settings = Settings(data_root=directory / 'data')
    settings.values.update(profile.values)
    settings.values.update(save_history=False, voice={'voice_mode': 'silent'})
    settings.key = profile.key
    class OwnedDesktop(WindowsDesktop):
        def list_windows(self):
            return [window for window in super().list_windows() if Path(window['executable']) == executable]
    desktop = OwnedDesktop()
    agent = AgentRuntime(settings, desktop, SilentTts())
    agent.system = SystemTools(agent.policy, catalog=ApplicationCatalog(lambda: [app_record('Ayana Open Probe', executable)]))
    report = {'scope': 'Native ShellExecuteEx, owned application, real HWND identity and screenshot', 'live_model': live_model, 'errors': []}
    original_emit = agent.emit
    async def emit(kind, **payload):
        if kind in {'error', 'tool.failed'}:
            report['errors'].append(payload.get('message', kind))
        return await original_emit(kind, **payload)
    agent.emit = emit
    try:
        if live_model:
            if not settings.key():
                raise RuntimeError('No model credential configured')
            await agent.handle({'type': 'turn.start', 'mode': 'execute',
                                'text': '请打开 Ayana Open Probe，然后把它选为目标窗口，观察它的标题。最后用一句日语简短回答。'})
            await agent.task
        else:
            agent.active_task = TaskRunner('Open and observe the owned application', {})
            agent.mode = 'execute'
            found = await agent._dispatch_tool({'name': 'apps.search', 'arguments': {'query': 'Ayana Open Probe'}})
            opened = await agent._dispatch_tool({'name': 'apps.open', 'arguments': {'app_id': found['result'][0]['app_id']}})
            assert opened['result']['status'] == 'window_observed', opened
            selected = await agent._dispatch_tool({'name': 'windows.select', 'arguments': {'window_id': opened['result']['windows'][0]['window_id']}})
            assert 'error' not in selected, selected
            agent.active_task.transition('succeeded')
        windows = desktop.list_windows()
        report.update(window_observed=bool(windows), target_selected=bool(agent.target and any(w['hwnd'] == agent.target['hwnd'] for w in windows)),
                      screenshot_received=bool(agent.snapshot and agent.snapshot.get('png_base64')), task=agent.active_task.public())
        report['passed'] = all(report[field] for field in ('window_observed', 'target_selected', 'screenshot_received')) and not report['errors']
    except Exception as error:
        report.update(passed=False)
        report['errors'].append(str(error)[:500])
    finally:
        # Close only the fixture HWND after verifying its current executable identity.
        api = Win32()
        for window in desktop.list_windows():
            current = api.identity(window['hwnd'])
            if Path(current['executable']) == executable and current['process_created'] == window['process_created']:
                api.user.PostMessageW(ctypes.c_void_p(current['hwnd']), 0x10, 0, 0)
        await agent.close()
        (directory / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({**report, 'directory': str(directory)}, ensure_ascii=False, indent=2))
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live-model', action='store_true')
    args = parser.parse_args()
    sys.exit(0 if asyncio.run(main(args.live_model)) else 1)
