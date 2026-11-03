"""The Immich settings the web app reads (W57): IMMICH_URL and IMMICH_INBOX from
the environment, else the MCP's immich.conf. No pytest needed:
    python tests/test_immich_conf.py [--brief]"""

import os
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dtweb import main as M  # noqa: E402

KEYS = ("IMMICH_URL", "IMMICH_INBOX", "DTWEB_IMMICH_CONF")


def conf(text: str | None, **env) -> dict:
    d = Path(tempfile.mkdtemp())
    for k in KEYS:
        os.environ.pop(k, None)
    os.environ["DTWEB_IMMICH_CONF"] = str(d / "immich.conf")
    if text is not None:
        (d / "immich.conf").write_text(text)
    os.environ.update(env)
    return M._immich_conf()


def test_not_configured():
    c = conf(None)
    assert c == {"configured": False, "inbox": "Edit in darktable", "web": ""}, c
    assert not conf("# nothing\nIMMICH_URL=\n")["configured"]


def test_conf_file():
    c = conf("# comment\nexport IMMICH_URL='https://immich.example.com/api/'\nIMMICH_INBOX=To edit\n")
    assert c == {"configured": True, "inbox": "To edit", "web": "https://immich.example.com"}, c


def test_env_wins():
    c = conf("IMMICH_URL=https://a.example/api\n", IMMICH_URL="http://127.0.0.1:9/api", IMMICH_INBOX="Box")
    assert c == {"configured": True, "inbox": "Box", "web": "http://127.0.0.1:9"}, c


def test_url_without_api():
    assert conf(None, IMMICH_URL="https://i.example.com")["web"] == "https://i.example.com"


if __name__ == "__main__":
    brief = "--brief" in sys.argv
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    bad = 0
    for n, f in tests:
        try:
            f()
            if not brief:
                print("ok  ", n)
        except Exception:
            bad += 1
            print("FAIL", n)
            traceback.print_exc()
    print(f"test_immich_conf: {len(tests) - bad}/{len(tests)} passed")
    sys.exit(1 if bad else 0)
