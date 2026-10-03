import argparse
import os
import uvicorn
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Ayana authenticated loopback runtime")
    parser.add_argument("--port", type=int, default=17321)
    parser.add_argument("--token", default=os.environ.get("AYANA_RUNTIME_TOKEN", ""))
    args = parser.parse_args()
    app = create_app(args.token)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning", ws_max_size=2 * 1024 * 1024)
    server = uvicorn.Server(config)
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
