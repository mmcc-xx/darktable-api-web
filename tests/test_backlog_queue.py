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
YESTERDAY = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
QUEUE = """# Queue

## Queue
- [x] **#1** done already. est 1.0
- [ ] **#2** first. est 1.0
- [ ] **#3** second. est 2.0
- [ ] **#4** with a partial. est 3.0
  - Partial (2026-11-01): night/4 abc; left 0.5: tests
- [ ] **W5** unsized, queued as a draft. est draft
"""


def setup(d: Path, note: str | None, runs: str | None, tonight: str | None, day: str = TODAY) -> None:
    (d / "forecast").mkdir(exist_ok=True)
    for old in d.glob("night-run-*.md"):
        old.unlink()
    (d / "QUEUE.md").write_text(QUEUE)
    (d / "forecast/RATES.md").write_text("Bias (actual ÷ est) 1.0 (test).\n")
    for name, text in ((f"night-run-{day}.md", note), ("forecast/runs.tsv", runs), ("forecast/tonight.md", tonight)):
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
        log = d / "night.log"
        os.environ["DTWEB_NIGHT_LOG"] = str(log)
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

        def day_caps():
            at = datetime.datetime.fromisoformat
            got = [B.day_cap(at(t)) for t in ("2026-11-04T18:00-05:00", "2026-11-05T18:00-05:00",
                                              "2026-11-05T22:30-05:00", "2026-11-06T18:00-05:00",
                                              "2026-10-29T18:00-04:00", "2026-10-30T18:00-04:00")]
            assert got == [(6, 84), (7, 100), (1, 14), (1, 14), (7, 100), (1, 14)], got
            (d / "launchd").mkdir(exist_ok=True)
            (d / "launchd/.cap-2026-11-04").write_text("80\n")
            assert B.day_cap(at("2026-11-04T18:00-05:00")) == (6, 80)
            (d / "launchd/.cap-2026-11-04").unlink()
        check("day caps: 14% a day from the Thursday reset, .cap- override", day_caps)

        def today_from_last_night():
            log.unlink(missing_ok=True)
            setup(d, f"{YESTERDAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n",
                  None, None, YESTERDAY)
            start = datetime.datetime.combine(datetime.date.today(), datetime.time(18)).astimezone()
            day, cap = B.day_cap(start)
            c = B.night_capacity()
            week = 0.0 if datetime.date.today().weekday() == 4 else 60.0    # Friday: reset since last night
            assert (c["cap"], c["week"], c["pts"], c["today"]) == (cap, week, cap - 1 - week, True), c
            assert f"day {day}" in c["src"], c
        check("before today's run: today's cap, last night's week", today_from_last_night)

        def log_newer():
            setup(d, f"{YESTERDAY} 18:00:01 run starting (session 5%, week 60%, cap 70%, 4 items open)\n",
                  None, None, YESTERDAY)
            log.write_text(f"{YESTERDAY} 18:00:09 daily run: day 5 of the week, cap week 70%, session 90% "
                           f"(kill 97%), until x; now session 7%, week 61%\n{YESTERDAY} 19:00:00 usage: "
                           "session 50%, week 66%\nunrelated line\n")
            c = B.night_capacity()
            assert "night-run log" in c["src"] and c["week"] == (0.0 if datetime.date.today().weekday() == 4 else 66.0), c
            log.unlink()
        check("a newer week % in the night-run log wins", log_newer)

        def reset_since():
            old = (datetime.date.today() - datetime.timedelta(days=8)).isoformat()
            setup(d, f"{old} 18:00:01 run starting (session 5%, week 90%, cap 98%, 4 items open)\n",
                  None, None, old)
            c = B.night_capacity()
            assert c["week"] == 0.0 and "reset" in c["src"], c
        check("a week % from before the weekly reset counts as 0", reset_since)

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
