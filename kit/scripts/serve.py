"""Serves the page for development without caching, so an edit shows on
reload. The page is at /web/, and finds the kit's modules at /kit/web/;
nothing else of the repository is served (dev/ holds the node's control token,
.devchain.json the test keys).

    python3 kit/scripts/serve.py [port]
"""
import functools
import http.server
import pathlib
import sys

SERVED = ("/web/", "/kit/web/")


class NoStore(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        if not path.startswith(SERVED) or ".." in path:
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = pathlib.Path(__file__).resolve().parent.parent.parent
handler = functools.partial(NoStore, directory=str(root))
print(f"http://127.0.0.1:{port}/web/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
