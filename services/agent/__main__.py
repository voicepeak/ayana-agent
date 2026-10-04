import argparse
import logging
import os
from pathlib import Path
import uvicorn
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Ayana authenticated loopback runtime")
    parser.add_argument("--port", type=int, default=17321)
    parser.add_argument("--token", default=os.environ.get("AYANA_RUNTIME_TOKEN", ""))
    parser.add_argument("--data-dir", type=Path, help="Explicit personal configuration and history directory")
    args = parser.parse_args()
    from .config import Settings
    app = create_app(args.token, settings=Settings(data_root=args.data_dir))
    settings = app.state.runtime.settings
    logging.getLogger('ayana.runtime').warning(
        "Runtime config: path=%s exists=%s provider=%s voice=%s credentials=%s",
        settings.path, settings.path.is_file(), settings.values['provider'],
        settings.values.get('voice', {}).get('voice_mode', 'auto'), bool(settings.key()))
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning", ws_max_size=2 * 1024 * 1024)
    server = uvicorn.Server(config)
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
