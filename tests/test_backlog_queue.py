"""The backlog page's queue view (#160): the night's capacity and the items
likely done, against scratch backlog files. No pytest needed:
    python tests/test_backlog_queue.py [--brief]"""

import datetime
import os
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dtweb import backlog as B  # noqa: E402

TODAY = datetime.date.today().isoformat()
QUEUE = """# Queue

## Queue
- [x] **#1** done already. est 1.0
- [ ] **#2** first. est 1.0
- [ ] **#3** second. est 2.0
- [ ] **#4** with a partial. est 3.0
  - Partial (2026-11-01): night/4 abc; left 0.5: tests
- [ ] **W5** unsized, queued as a draft. est draft
"""


def setup(d: Path, note: str | None, runs: str | None, tonight: str | None) -> None:
    (d / "forecast").mkdir(exist_ok=True)
    (d / "QUEUE.md").write_text(QUEUE)
    (d / "forecast/RATES.md").write_text("Bias (actual ÷ est) 1.0 (test).\n")
    for name, text in ((f"night-run-{TODAY}.md", note), ("forecast/runs.tsv", runs), ("forecast/tonight.md", tonight)):
        p = d / name
        if text is None:
            p.unlink(missing_ok=True)
        else:
            p.write_text(text)


def walk(d: Path) -> list[tuple[str, str]]:
    cap = B.night_capacity()
    opens = [i for i in B.parse_queue(B.read_lines("QUEUE.md")) if B.is_open(i)]
    for i in opens:
        i["pts_n"] = float(i["left"]) if i["left"] else float(i["est"]) if i["est"] not in ("", "draft") else B.NO_EST
    B.mark_likely(opens, cap["pts"], B.rates_bias())
    return [(i["label"], i["likely"]) for i in opens]


def main() -> int:
    brief, fails, n = "--brief" in sys.argv, [], 0
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        os.environ["DTWEB_BACKLOG_DIR"] = str(d)
        checks = []

        def check(name, fn):
            checks.append((name, fn))

        def from_note():
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n", None, None)
            c = B.night_capacity()
            assert (c["pts"], c["cap"], c["week"], c["today"]) == (9.0, 70, 60.0, True), c
        check("capacity from the night note", from_note)

        def later_start_wins():
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n"
                     f"{TODAY} 18:30:01 run starting (session 25%, week 65%, cap 70%, 3 items open)\n", None, None)
            assert B.night_capacity()["pts"] == 4.0
        check("the last run start counts", later_start_wins)

        def runs_tsv_after():
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n",
                  "start\tend\tmin\twhy\ts0\tw0\ts1\tw1\tcost\tbox\titem\n"
                  f"{TODAY} 18:00:01\t{TODAY} 18:20:00\t20\tself\t5\t60\t30\t66\t1.0\t[x]\t#2\n", None)
            c = B.night_capacity()
            assert c["pts"] == 3.0 and "runs.tsv" in c["src"], c
        check("a run that ended since: its week", runs_tsv_after)

        def old_runs_ignored():
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n",
                  "start\tend\tmin\twhy\ts0\tw0\ts1\tw1\tcost\tbox\titem\n"
                  "2026-01-01 18:00:01\t2026-01-01 18:20:00\t20\tself\t5\t1\t30\t2\t1.0\t[x]\t#2\n", None)
            assert B.night_capacity()["pts"] == 9.0
        check("an older run in runs.tsv is ignored", old_runs_ignored)

        def from_forecast():
            setup(d, None, None, f"# Forecast {TODAY} (queue_forecast.py)\n\nStart 18:00, cap 56%, week 53% now, "
                                 "budget 2.8 weekly points, bias 0.95.\n")
            c = B.night_capacity()
            assert c["pts"] == 2.8 and "tonight.md" in c["src"], c
        check("capacity from tonight's forecast", from_forecast)

        def nothing():
            setup(d, None, None, None)
            assert B.night_capacity() is None
        check("no sources: none", nothing)

        def likely():
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 65%, 4 items open)\n", None, None)
            # 4 pts: partial #4 (0.5) first, #2 1.0, #3 2.0 -> 3.5, W5 (1.0) partial
            assert walk(d) == [("#2", "done"), ("#3", "done"), ("#4", "done"), ("W5", "partial")], walk(d)
            setup(d, f"{TODAY} 18:00:01 run starting (session 5%, week 60%, cap 63%, 4 items open)\n", None, None)
            assert walk(d) == [("#2", "done"), ("#3", "partial"), ("#4", "done"), ("W5", "not reached")], walk(d)
        check("likely done: partial first, then in order", likely)

        for name, fn in checks:
            n += 1
            try:
                fn()
                if not brief:
                    print(f"ok   {name}")
            except Exception:
                fails.append(name)
                print(f"FAIL {name}\n{traceback.format_exc()}")
    print(f"test_backlog_queue: {n - len(fails)}/{n}" + (f", failed: {', '.join(fails)}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
