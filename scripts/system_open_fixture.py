"""Create/remove one owned application registration for packaged GUI verification."""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import winreg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native.windows.win32 import Win32


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['create', 'cleanup'])
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_relative_to((ROOT / '.runtime/benchmarks').resolve()) or not directory.name.isdigit():
        raise ValueError('Fixture must use a numeric benchmark directory')
    name = 'AyanaSystemProbe' + directory.name
    target = directory / (name + '.exe')
    key = r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' + '\\' + name + '.exe'
    if args.mode == 'create':
        if target.exists():
            raise ValueError('Use a fresh fixture directory')
        directory.mkdir(parents=True, exist_ok=True)
        source = directory / 'SystemProbe.cs'
        source.write_text('''using System; using System.Windows.Forms;
class Probe { [STAThread] static void Main() { Application.EnableVisualStyles();
Application.Run(new Form { Text="Ayana System Probe", Width=480, Height=300 }); } }
''', encoding='utf-8')
        compiler = Path(os.environ['SystemRoot']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        subprocess.run([str(compiler), '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll',
                        '/reference:System.Drawing.dll', '/out:' + str(target), str(source)],
                       capture_output=True, timeout=30, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key):
                raise ValueError('Fixture registration already exists')
        except FileNotFoundError:
            pass
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as created:
            winreg.SetValueEx(created, '', 0, winreg.REG_SZ, str(target))
        print(json.dumps({'name': name, 'target': str(target)}))
    else:
        api = Win32()
        for window in api.enumerate():
            if Path(window['executable']) == target:
                current = api.identity(window['hwnd'])
                if current['process_created'] == window['process_created'] and Path(current['executable']) == target:
                    api.user.PostMessageW(ctypes.c_void_p(current['hwnd']), 0x10, 0, 0)
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as registered:
                if winreg.QueryValueEx(registered, None)[0] != str(target):
                    raise ValueError('Fixture registration changed; preserving it')
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except FileNotFoundError:
            pass


if __name__ == '__main__':
    main()
