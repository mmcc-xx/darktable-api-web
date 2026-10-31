"""The import dialog's remembered rejects (#156) and removing a file from an
upload batch, against temp paths. No pytest needed:
    python tests/test_import_rejects.py [--brief]"""

import sys
import tempfile
import traceback
import warnings
from pathlib import Path

warnings.simplefilter("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fastapi.testclient import TestClient  # noqa: E402

from dtweb import main  # noqa: E402


def f(name, size=10, mtime=100):
    return {"name": name, "size": size, "mtime": mtime}


def check(c, *files):
    r = c.post("/api/import/rejects/check", json={"files": list(files)})
    assert r.status_code == 200, r.text
    return r.json()["rejected"]


def test_rejects(c, tmp):
    assert check(c, f("a.RW2"), f("b.RW2")) == [False, False]
    r = c.post("/api/import/rejects", json={"reject": [f("a.RW2"), f("b.RW2")], "keep": []})
    assert r.json() == {"rejected": 2}
    assert check(c, f("a.RW2"), f("b.RW2"), f("c.RW2")) == [True, True, False]
    assert check(c, f("a.RW2", size=11), f("a.RW2", mtime=101), f("sub/a.RW2")) == [False, False, True]
    c.post("/api/import/rejects", json={"reject": [], "keep": [f("a.RW2")]})
    assert check(c, f("a.RW2"), f("b.RW2")) == [False, True]
    assert not list(tmp.glob("*.tmp"))


def test_cap(c, tmp):
    old = {f"x{i}|1|1": "2020-01-01" for i in range(main.REJECTS_MAX)}
    main._rejects_write(old)
    c.post("/api/import/rejects", json={"reject": [f("new.RW2")], "keep": []})
    d = main._rejects_read()
    assert len(d) == main.REJECTS_MAX and "new.RW2|10|100" in d
    assert "x0|1|1" not in d and f"x{main.REJECTS_MAX - 1}|1|1" in d


def test_corrupt(c, tmp):
    main.REJECTS.write_text("{not json")
    assert check(c, f("a.RW2")) == [False]
    main.REJECTS.write_text("[1, 2]")
    assert check(c, f("a.RW2")) == [False]
    assert c.post("/api/import/rejects", json={"reject": [f("a.RW2")], "keep": []}).json() == {"rejected": 1}


def test_delete(c, tmp):
    b = tmp / "web-uploads" / "abc123"
    b.mkdir(parents=True)
    (b / "a.RW2").write_bytes(b"x")
    (b / "a.RW2.part").write_bytes(b"x")
    (b / "b.RW2").write_bytes(b"x")
    assert c.delete("/api/import/upload/abc123", params={"name": "a.RW2"}).status_code == 200
    assert [p.name for p in b.iterdir()] == ["b.RW2"]
    assert c.delete("/api/import/upload/abc123", params={"name": "a.RW2"}).status_code == 200   # missing is fine
    assert c.delete("/api/import/upload/abc123", params={"name": "../../b.RW2"}).status_code == 200  # basename only
    assert not list(b.iterdir())
    (b / "b.RW2").write_bytes(b"x")
    assert c.delete("/api/import/upload/ab-c", params={"name": "b.RW2"}).status_code == 400
    assert c.delete("/api/import/upload/" + "a" * 41, params={"name": "b.RW2"}).status_code == 400
    assert c.delete("/api/import/upload/abc123", params={"name": ".hidden"}).status_code == 400
    assert c.delete("/api/import/upload/abc123", params={"name": "x.part"}).status_code == 400
    assert (b / "b.RW2").exists()


if __name__ == "__main__":
    brief, failed = "--brief" in sys.argv, []
    tests = [(n, fn) for n, fn in list(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            main.REJECTS, main.UPLOADS = tmp / "web-upload-rejects.json", tmp / "web-uploads"
            try:
                fn(TestClient(main.app), tmp)
                brief or print("ok  ", name)
            except Exception:
                failed.append(name)
                print("FAIL", name)
                traceback.print_exc()
    print(f"{len(tests) - len(failed)} passed, {len(failed)} failed" if failed or not brief else f"ok: {len(tests)} passed")
    sys.exit(1 if failed else 0)
