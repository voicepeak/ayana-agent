import argparse
import logging
import os
from pathlib import Path
import uvicorn
from .config import ROOT, Settings
from .mobile import load_or_create_token, token_path
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Ayana authenticated runtime")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17321)
    parser.add_argument("--token", default=os.environ.get("AYANA_RUNTIME_TOKEN", ""))
    parser.add_argument("--data-dir", type=Path, help="Explicit personal configuration and history directory")
    parser.add_argument("--mobile-root", type=Path, default=ROOT / "apps/mobile/dist",
                        help="Built mobile web client directory")
    parser.add_argument("--no-mobile", action="store_true", help="Do not serve the mobile web client")
    parser.add_argument("--mobile-apk", type=Path, default=ROOT / "release/mobile",
                        help="Android package file or directory to offer from the mobile page")
    parser.add_argument("--allowed-origin", action="append", default=[],
                        help="Additional allowed WebSocket origins; repeatable")
    args = parser.parse_args()
    settings = Settings(data_root=args.data_dir)
    mobile_root = None if args.no_mobile else args.mobile_root
    mobile_token = None
    if mobile_root is not None:
        mobile_token = load_or_create_token(settings.data_root)
    app = create_app(args.token, settings=settings, mobile_root=mobile_root,
                     mobile_token=mobile_token, mobile_apk=args.mobile_apk,
                     allowed_origins=args.allowed_origin)
    logging.getLogger('ayana.runtime').warning(
        "Runtime config: path=%s exists=%s provider=%s voice=%s credentials=%s",
        settings.path, settings.path.is_file(), settings.values['provider'],
        settings.values.get('voice', {}).get('voice_mode', 'auto'), bool(settings.key()))
    if mobile_token:
        logging.getLogger('ayana.runtime').warning(
            "Mobile client: root=%s token_file=%s", mobile_root,
            token_path(settings.data_root))
    config = uvicorn.Config(app, host=args.host, port=args.port, access_log=False, log_level="warning",
                            ws_max_size=2 * 1024 * 1024)
    server = uvicorn.Server(config)
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
