"""Owned local test application; useful for safe desktop input demos.

python -m native.windows.demo_target --state .local/demo-target.json
The state file contains HWND and widget rectangles in physical screen pixels.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import tkinter as tk
from tkinter import ttk


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, default=Path(".local/demo-target.json"))
    parser.add_argument("--auto-close", type=int, default=0)
    args = parser.parse_args()
    from .win32 import Win32
    api = Win32()
    root = tk.Tk()
    root.title("Ayana · 安全操作演示")
    root.geometry("680x480+100+100")
    root.configure(background="#eef4f3")
    frame = ttk.Frame(root, padding=30)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="Ayana Desktop · Test Window", font=("Segoe UI", 22)).pack(anchor="w")
    ttk.Label(frame, text="This window belongs to the demo. Practice one action at a time.").pack(anchor="w", pady=(8, 26))
    ttk.Label(frame, text="Your message").pack(anchor="w")
    entry = ttk.Entry(frame, font=("Segoe UI", 16))
    entry.pack(fill="x", pady=(8, 18))
    output = tk.StringVar(value="Waiting for a verified single step…")
    button = ttk.Button(frame, text="Apply message", command=lambda: output.set(f"Received: {entry.get()}"))
    button.pack(anchor="w", pady=(0, 20))
    ttk.Label(frame, textvariable=output, font=("Segoe UI", 13), wraplength=580).pack(anchor="w")
    ttk.Label(frame, text="Ayana should capture this window, highlight the field,\ntype only when you choose Execute, and observe the result.").pack(anchor="w", pady=(28, 0))
    args.state.parent.mkdir(parents=True, exist_ok=True)
    def publish():
        root.update_idletasks()
        hwnd = api.root(root.winfo_id())
        target = api.identity(hwnd)
        data = {"hwnd": hwnd, "target": target, "message": entry.get(), "output": output.get(), "widgets": {}}
        for name, widget in [("entry", entry), ("button", button)]:
            data["widgets"][name] = {"x": widget.winfo_rootx(), "y": widget.winfo_rooty(), "width": widget.winfo_width(), "height": widget.winfo_height()}
        args.state.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        root.after(100, publish)
    root.after(100, publish)
    if args.auto_close:
        root.after(args.auto_close * 1000, root.destroy)
    root.mainloop()


if __name__ == "__main__":
    main()
