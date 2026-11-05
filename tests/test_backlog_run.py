"""The queue tab's night-run bar (W66): today's cap (launchd/.cap-<date>),
run queue now (a stubbed launchctl kickstart) and the run status, against
scratch backlog files. No pytest needed:
    python tests/test_backlog_run.py [--brief]"""

import datetime
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dtweb import backlog as B  # noqa: E402

TODAY = datetime.date.today().isoformat()
QUEUE = """# Queue

## Queue
- [x] **#1** done already. est 1.0
- [ ] **#2** first. est 1.0
- [ ] **W4** with a partial. est 3.0
  - Partial (2026-11-01): night/W4 abc; left 0.5: tests
"""


def body(resp) -> tuple[int, dict]:
    return resp.status_code, json.loads(resp.body)


def main() -> int:
    brief, fails, n = "--brief" in sys.argv, [], 0
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "launchd").mkdir()
        (d / "forecast").mkdir()
        os.environ["DTWEB_BACKLOG_DIR"] = str(d)
        os.environ["DTWEB_NIGHT_LOG"] = str(d / "night.log")
        stub = d / "kick.log"
        os.environ["DTWEB_KICKSTART"] = f"/bin/sh -c 'echo kicked >> {stub}'"
        lock, capf = d / "launchd/.daily-run.lock", d / f"launchd/.cap-{TODAY}"
        checks = []

        def reset(queue=QUEUE):
            (d / "QUEUE.md").write_text(queue)
            (d / f"night-run-{TODAY}.md").write_text(f"\n{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 2 items open)\n\n## #2 first — done\n- Pushed: x\n")
            capf.unlink(missing_ok=True)
            stub.unlink(missing_ok=True)
            if lock.exists():
                (lock / "pid").unlink(missing_ok=True)
                lock.rmdir()

        def check(name, fn):
            checks.append((name, fn))

        def status_idle():
            reset()
            st = B.run_status()
            assert (st["held"], st["stale"], st["open"], st["item"], st["override"]) == (False, False, 2, "W4", None), st
            assert st["cap"] == st["week_cap"] and 1 <= st["day"] and st["week"] == 60.0, st
            assert st["last"] == "- Pushed: x" and st["note"] == f"night-run-{TODAY}.md", st
        check("idle: next item is the partial, cap from the reset, last note line", status_idle)

        def cap_write():
            reset()
            code, j = body(B.backlog_cap(B.CapBody(cap=55)))
            assert code == 200 and capf.read_text().strip() == "55" and (j["cap"], j["override"]) == (55, 55), (code, j)
            assert B.day_cap(datetime.datetime.now().astimezone())[1] == 55
            code, j = body(B.backlog_cap(B.CapBody(cap=None)))
            assert code == 200 and not capf.exists() and j["override"] is None and j["cap"] == j["week_cap"], (code, j)
            code, j = body(B.backlog_cap(B.CapBody(cap=None)))                 # removing twice is fine
            assert code == 200
        check("cap: write, read back as daily-run.sh does, remove", cap_write)

        def cap_capacity():
            reset()
            assert B.night_capacity()["cap"] == 70                              # the run start's
            B.backlog_cap(B.CapBody(cap=80))
            c = B.night_capacity()
            assert (c["cap"], c["pts"]) == (80, 19.0) and "set for today" in c["src"], c
            lock.mkdir()
            (lock / "pid").write_text(f"{os.getpid()}\n")
            assert B.night_capacity()["cap"] == 70                              # a run going keeps its own
        check("cap: the capacity line uses it while no run is going", cap_capacity)

        def cap_bad():
            reset()
            for v in (0, 101, -5):
                code, j = body(B.backlog_cap(B.CapBody(cap=v)))
                assert code == 400 and not capf.exists(), (v, code, j)
        check("cap: out of range refused", cap_bad)

        def cap_while_running():
            reset()
            lock.mkdir()
            (lock / "pid").write_text(f"{os.getpid()}\n")
            code, j = body(B.backlog_cap(B.CapBody(cap=70)))
            assert code == 200 and j["held"] and capf.read_text().strip() == "70", (code, j)
        check("cap: written while a run holds the lock", cap_while_running)

        def run_now():
            reset()
            code, j = body(B.backlog_run_now())
            assert code == 200 and j["started"] and stub.read_text() == "kicked\n", (code, j)
        check("run now: kickstart runs", run_now)

        def run_refused_running():
            reset()
            lock.mkdir()
            (lock / "pid").write_text(f"{os.getpid()}\n")
            (d / f"night-run-{TODAY}.md").write_text(f"x\n\n{datetime.datetime.now():%Y-%m-%d %H:%M:%S} run starting (session 5%, week 60%, cap 70%, 2 items open)\n")
            st = B.run_status()
            assert st["held"] and st["pid"] == os.getpid() and st["since"] and st["run_cap"] == 70 and st["item_since"], st
            code, j = body(B.backlog_run_now())
            assert code == 409 and "night run is going" in j["error"] and not stub.exists(), (code, j)
        check("run now: refused while a run holds the lock; status names it", run_refused_running)

        def run_stale_lock():
            reset()
            p = subprocess.Popen(["true"])
            p.wait()                                                          # a pid that is gone
            lock.mkdir()
            (lock / "pid").write_text(f"{p.pid}\n")
            st = B.run_status()
            assert not st["held"] and st["stale"], st
            code, j = body(B.backlog_run_now())
            assert code == 200 and stub.exists(), (code, j)
        check("run now: a stale lock doesn't block", run_stale_lock)

        def run_refused_empty():
            reset("# Queue\n\n## Queue\n- [x] **#1** done. est 1.0\n")
            code, j = body(B.backlog_run_now())
            assert code == 409 and "no open item" in j["error"] and not stub.exists(), (code, j)
        check("run now: refused with an empty queue", run_refused_empty)

        def run_kick_fails():
            reset()
            os.environ["DTWEB_KICKSTART"] = "/bin/sh -c 'echo no such service >&2; exit 113'"
            try:
                code, j = body(B.backlog_run_now())
            finally:
                os.environ["DTWEB_KICKSTART"] = f"/bin/sh -c 'echo kicked >> {stub}'"
            assert code == 500 and "113" in j["error"] and "no such service" in j["error"], (code, j)
        check("run now: a failed kickstart is reported", run_kick_fails)

        def default_cmd():
            v = os.environ.pop("DTWEB_KICKSTART")
            try:
                assert B.kickstart_cmd() == ["launchctl", "kickstart", f"gui/{os.getuid()}/com.clark.darktable-daily-run"]
            finally:
                os.environ["DTWEB_KICKSTART"] = v
        check("kickstart: no -k, the daily-run agent", default_cmd)

        status_file = d / "launchd/.run-status.json"

        def write_status(state, age=10, **kw):
            status_file.write_text(json.dumps({"state": state, "why": "w", "item": "#2", "time": int(time.time()) - age, **kw}))

        def dash_none():
            reset()
            status_file.unlink(missing_ok=True)
            assert B.run_status()["dash"] is None
            status_file.write_text("{ not json")
            assert B.run_status()["dash"] is None
            status_file.write_text('{"state": "running"}')
            assert B.run_status()["dash"] is None
        check("dashboard: no file, bad JSON or no time gives none", dash_none)

        def dash_running():
            reset()
            lock.mkdir()
            (lock / "pid").write_text(f"{os.getpid()}\n")
            write_status("running", session=12, week=60)
            dash = B.run_status()["dash"]
            assert dash["state"] == "running" and dash["session"] == 12 and 10 <= dash["age"] < 15 and not dash["late"], dash
            write_status("waiting", age=400)
            dash = B.run_status()["dash"]
            assert dash["state"] == "waiting" and dash["late"], dash
        check("dashboard: a going run, and late after five minutes", dash_running)

        def dash_stopped():
            reset()
            write_status("running")
            dash = B.run_status()["dash"]
            assert dash["state"] == "stopped" and dash["last_state"] == "running" and not dash["late"], dash
            write_status("cap", age=40000)
            dash = B.run_status()["dash"]
            assert dash["state"] == "cap" and dash["age"] >= 40000 and not dash["late"], dash
        check("dashboard: going without the lock is stopped; a finished run stays", dash_stopped)

        for name, fn in checks:
            n += 1
            try:
                fn()
                if not brief:
                    print(f"ok   {name}")
            except Exception:
                fails.append(name)
                print(f"FAIL {name}\n{traceback.format_exc()}")
        reset()
    print(f"test_backlog_run: {n - len(fails)}/{n}" + (f", failed: {', '.join(fails)}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
