"""The backlog page's ideas tab (#146) against a scratch copy of IDEAS.md:
edit cells and a description, add, delete, stale hashes. No pytest needed:
    python tests/test_backlog_ideas.py [--brief]
DTWEB_IDEAS=/path/to/IDEAS.md picks the copy (default: the darktableluamcp
checkout's)."""

import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dtweb import backlog as B  # noqa: E402

SRC = Path(os.environ.get("DTWEB_IDEAS") or Path(B.DEFAULT_DIR) / "IDEAS.md")


@contextlib.contextmanager
def raises_reply():
    class Caught:
        value = None
    c = Caught()
    try:
        yield c
    except B.Reply as r:
        c.value = r
    else:
        raise AssertionError("no Reply raised")


def make_repo(tmp: str) -> Path:
    d = Path(tmp) / "darktable-api"
    d.mkdir()
    shutil.copy(SRC, d / "IDEAS.md")
    for name in ("FEATURES.md", "BUGS.md", "QUEUE.md"):
        (d / name).write_text("# empty\n")
    git = ["git", "-C", str(d), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", str(d)], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-qm", "base"], check=True)
    os.environ.update(DTWEB_BACKLOG_DIR=str(d), GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                      GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return d


def call(fn, body):
    with B.write_guard():
        return fn(body)


def row(lines, rid):
    return B.find_row(lines, rid, B.OPEN["ideas"])[1]


def log(d):
    return subprocess.run(["git", "-C", str(d), "log", "--format=%s"], capture_output=True, text=True).stdout.split("\n")


def test_edit_scores(repo):
    before = B.read_lines("IDEAS.md")
    r = row(before, "I13")
    out = call(B.do_edit, B.EditBody(file="ideas", id="I13", row_hash=B.sha(r["text"]), cells={"Value": "5"}))
    assert out["changed"] and out.get("commit")
    after = B.read_lines("IDEAS.md")
    assert after[r["line"]] == "| I13 | Film emulation LUTs through `lut3d` | look | 5 | 1 | 1 | 7 | 2 | 3.5 |"
    assert [l for i, l in enumerate(after) if i != r["line"]] == [l for i, l in enumerate(before) if i != r["line"]]
    assert log(repo)[0] == "backlog: edit I13 scores, from the web page"


def test_two_decimals(repo):
    r = row(B.read_lines("IDEAS.md"), "P1")
    call(B.do_edit, B.EditBody(file="ideas", id="P1", row_hash=B.sha(r["text"]), cells={"Time": "2"}))
    assert B.read_lines("IDEAS.md")[r["line"]].endswith("| 15 | 8 | 1.88 |") is False      # 15/8 = 1.875: one decimal
    assert B.read_lines("IDEAS.md")[r["line"]].endswith("| 15 | 8 | 1.9 |")


def test_edit_description(repo):
    before = B.read_lines("IDEAS.md")
    b, shared = B.bullet_of(before, "I2")
    assert not shared and b["lead"] == "**I2 Burst merge.**"
    text = "A new, longer text for the burst merge idea. " * 4
    r = row(before, "I2")
    out = call(B.do_edit, B.EditBody(file="ideas", id="I2", row_hash=B.sha(r["text"]), cells={},
                                     description=text, desc_hash=B.sha(b["text"])))
    assert out["changed"]
    after = B.read_lines("IDEAS.md")
    n = len(B.wrap_bullet(b["lead"], " ".join(text.split())))
    nb = after[b["start"]:b["start"] + n]
    assert n > 1 and nb[0].startswith("- **I2 Burst merge.** A new, longer") and all(len(l) <= 76 for l in nb)
    assert all(l.startswith("  ") for l in nb[1:])
    assert after[:b["start"]] == before[:b["start"]] and after[b["start"] + n:] == before[b["end"]:]
    assert B.bullet_of(after, "I2")[0]["body"] == " ".join(text.split())
    assert log(repo)[0] == "backlog: edit I2 description, from the web page"


def test_stale_hashes(repo):
    lines = B.read_lines("IDEAS.md")
    with raises_reply() as e:
        call(B.do_edit, B.EditBody(file="ideas", id="I13", row_hash="stale", cells={"Value": "8"}))
    assert e.value.status == 409 and e.value.body["current"].startswith("| I13 |")
    r = row(lines, "I2")
    with raises_reply() as e:
        call(B.do_edit, B.EditBody(file="ideas", id="I2", row_hash=B.sha(r["text"]), cells={},
                                   description="x", desc_hash="stale"))
    assert e.value.status == 409 and e.value.body["current"].startswith("- **I2 ")
    with raises_reply() as e:
        call(B.do_delete, B.DeleteBody(file="ideas", id="I2", row_hash="stale"))
    assert e.value.status == 409
    assert B.read_lines("IDEAS.md") == lines


def test_add_existing_section(repo):
    before = B.read_lines("IDEAS.md")
    out = call(B.do_add, B.AddBody(kind="idea", series="I", title="Test idea", text="Does a thing.", area="look",
                                   section="Masks", scores={"Value": "8", "Time": "1", "Risk/enable": "1", "Size": "2"}))
    rid = out["id"]
    assert rid == f"I{B.next_idea_number(chr(10).join(before), 'I') }" and log(repo)[0].startswith(f"backlog: add {rid} Test idea")
    after = B.read_lines("IDEAS.md")
    t = [t for t in B.parse_tables(after) if t["section"] == "The list"][0]
    assert t["rows"][0]["id"] == rid and t["rows"][0]["cells"][-1] == "5.0"     # WSJF 10/2, above 2.7
    b, _ = B.bullet_of(after, rid)
    s, e = B.sections(after)["Masks"]
    assert s < b["start"] < e and b["body"].startswith("Does a thing.")
    assert len(after) == len(before) + 1 + (b["end"] - b["start"])


def test_add_new_section_unscored_then_delete(repo):
    before = B.read_text("IDEAS.md")
    out = call(B.do_add, B.AddBody(kind="idea", series="P", title="Print idea", text="", area=""))
    rid = out["id"]
    assert rid == "P7"
    lines = B.read_lines("IDEAS.md")
    t = [t for t in B.parse_tables(lines) if t["section"] == "The list"][0]
    assert t["rows"][-1]["id"] == "P7" and t["rows"][-1]["cells"][3:] == ["?"] * 6
    assert "## From the web page" in lines and lines[-1] == ""
    r = row(lines, "P7")
    out = call(B.do_delete, B.DeleteBody(file="ideas", id="P7", row_hash=B.sha(r["text"])))
    assert out["deleted"] == "P7" and out.get("commit")
    after = B.read_text("IDEAS.md")
    assert "P7" not in after and after == before


def test_delete_lists_mentions(repo):
    before = B.read_lines("IDEAS.md")
    r = row(before, "I12")
    b, _ = B.bullet_of(before, "I12")
    out = call(B.do_delete, B.DeleteBody(file="ideas", id="I12", row_hash=B.sha(r["text"])))
    after = B.read_lines("IDEAS.md")
    gone = {r["line"]} | set(range(b["start"], b["end"]))
    assert after == [l for i, l in enumerate(before) if i not in gone]
    assert out["mentions"] and all(m["file"] == "IDEAS.md" for m in out["mentions"])
    assert any("I12" in m["text"] for m in out["mentions"])
    assert log(repo)[0].startswith("backlog: delete I12 ")


def test_delete_shared_bullet_stays(repo):
    before = B.read_lines("IDEAS.md")
    r = row(before, "I30")
    out = call(B.do_delete, B.DeleteBody(file="ideas", id="I30", row_hash=B.sha(r["text"])))
    after = B.read_lines("IDEAS.md")
    assert after == before[:r["line"]] + before[r["line"] + 1:]
    assert any("I29-I32" in m["text"] for m in out["mentions"])


if __name__ == "__main__":
    brief, failed = "--brief" in sys.argv, []
    tests = [(n, f) for n, f in list(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                fn(make_repo(tmp))
                brief or print("ok  ", name)
            except Exception:
                failed.append(name)
                print("FAIL", name)
                traceback.print_exc()
    print(f"{len(tests) - len(failed)} passed, {len(failed)} failed" if failed or not brief else f"ok: {len(tests)} passed")
    sys.exit(1 if failed else 0)
