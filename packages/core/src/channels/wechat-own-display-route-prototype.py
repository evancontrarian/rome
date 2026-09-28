#!/usr/bin/env python3
"""PROTOTYPE, never merge. Round 4 phase 2 of rome-work personal-wechat-replies
(prototype-brief.md @ d2bc5d4): round 3's keyboard route on WeChat's own
display (:100), with every raise removed.

    python3 wechat-own-display-route-prototype.py send                  # the real send
    python3 wechat-own-display-route-prototype.py reliability --contact <name>

Round 3's route (wechat-user-send-a11y-only-prototype.py) is reused as is,
except that `bring_forward` no longer raises anything: on :100 WeChat is the
only normal window, so if it is not in front the run stops. The X focus check
before every key stays. Keys go through the AT-SPI registry, whose XTest
output lands on :100.

Environment: DISPLAY=:100, DBUS_SESSION_BUS_ADDRESS=<client's session bus>,
PYTHONPATH=/tmp/a11y/py, tools under /tmp/wxd (phase 1's fetch).
"""
import argparse
import importlib.util
import json
import os
import random
import subprocess
import sys
import time

os.environ.setdefault("DISPLAY", ":100")
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("r3", os.path.join(HERE, "wechat-user-send-a11y-only-prototype.py"))
r3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r3)
d, Route, Stop, trace = r3.d, r3.Route, r3.Stop, r3.trace

r3.XDO = "/tmp/wxd/root/usr/bin/xdotool"
r3.XENV = {**os.environ, "LD_LIBRARY_PATH": "/tmp/wxd/root/usr/lib/x86_64-linux-gnu"}
r3.THIEF_LOG = "/tmp/wxd/thief-keys.txt"
EWMH = "/tmp/wxd/ewmh.py"
counters = {"back_used": 0}


RAISE_ON_STEAL = False


def no_raise(self):
    """On a display of its own, WeChat is in front or something is wrong.
    With --raise-on-steal, one EWMH activate (X11) is allowed first."""
    self.win = self.wechat_x_window()
    if not self.front() and RAISE_ON_STEAL:
        ewmh(hex(self.win), "activate")
        time.sleep(0.3)
        trace("raise", via="EWMH _NET_ACTIVE_WINDOW (X11)")
    if not self.front():
        raise Stop("not-in-front", "WeChat is not in front on its display; nothing is raised or sent")


orig_search_box = Route.search_box


def counted_search_box(self):
    if d.search_box(self.frame) is None:
        counters["back_used"] += 1
    return orig_search_box(self)


Route.bring_forward = no_raise
Route.search_box = counted_search_box


def ewmh(win, op):
    subprocess.run([sys.executable, EWMH, os.environ["DISPLAY"], win, op], check=True)


def window_state(win):
    info = subprocess.run(["xwininfo", "-id", win], capture_output=True, text=True).stdout
    geom = [l.split()[-1] for l in info.splitlines() if l.strip().startswith(("Width", "Height"))]
    state = subprocess.run(["xprop", "-id", win, "_NET_WM_STATE"], capture_output=True, text=True).stdout
    return {"geom": "x".join(geom), "maximized": "MAXIMIZED_HORZ" in state, "hidden": "HIDDEN" in state}


def restore(win):
    """Harness only: put WeChat back in front and maximized after a run."""
    ewmh(win, "activate")
    ewmh(win, "maximize")
    time.sleep(0.6)


def setup(cond, win, contact):
    if cond == "leftover-search":
        box = d.search_box(d.main_frame(d.wechat_app()))
        box.grab_focus(); box.set_text("zzqx")
    elif cond == "other-chat":
        Route(d.wechat_app()).open_chat(contact)  # open only, nothing typed
    elif cond == "focus-steal":
        # A timer in this process, so the steal time is recorded against the run
        # and a steal never outlives its run.
        import threading
        delay = round(random.uniform(0.3, 5.0), 2)
        thief = r3.thief_window()
        steal = {"steal_after_s": delay, "fired_at": None}
        t0 = time.time()

        def fire():
            subprocess.run([r3.XDO, "windowactivate", thief], env=r3.XENV)
            steal["fired_at"] = round(time.time() - t0, 2)
        timer = threading.Timer(delay, fire)
        timer.start()
        steal["timer"] = timer
        return steal
    elif cond == "unmaximized":
        ewmh(win, "unmaximize")
    elif cond == "minimized":
        subprocess.run([r3.XDO, "windowminimize", "--sync", win], env=r3.XENV)
    time.sleep(0.8)
    return {}


CONDITIONS = (["idle"] * 3 + ["leftover-search"] * 5 + ["other-chat"] * 5 + ["contact-open-only"] * 5
              + ["focus-steal"] * 20 + ["unmaximized"] * 2 + ["minimized"] * 2)


def with_query(fn):
    """File Transfer is found only by "Transfer" (round 1); the match stays exact."""
    orig = d.Node.set_text
    d.Node.set_text = lambda self, s: orig(self, "Transfer" if s == "File Transfer" else s)
    try:
        return fn()
    finally:
        d.Node.set_text = orig


def reliability(args):
    r3.thief_window()
    win = hex(Route(d.wechat_app()).wechat_x_window())
    restore(win)
    results = []
    conds = [c for c in CONDITIONS if not args.only or c == args.only] * (1 if not args.only else 1)
    for i, cond in enumerate(conds, 1):
        before = os.path.getsize(r3.THIEF_LOG) if os.path.exists(r3.THIEF_LOG) else 0
        back_before = counters["back_used"]
        try:
            extra = setup(cond, win, args.contact)
        except Exception as e:  # noqa: BLE001
            extra = {"setup_error": str(e)[:120]}
        r = Route(d.wechat_app(), x_guard=True)
        t = time.time()
        try:
            if cond == "contact-open-only":
                box = r.open_chat(args.contact)  # reach the contact's input; type nothing
                out = {"input": box.name == args.contact, "text": box.text()}
                outcome = "opened" if out["input"] and out["text"] == "" else "wrong"
            else:
                with_query(lambda: r.run("File Transfer", "rome test"))
                outcome = "reached-and-cleared"
            code = reason = None
        except Stop as e:
            outcome, code, reason = "stopped", e.code, e.reason
        except LookupError as e:
            outcome, code, reason = "stopped", "tree-changed", str(e)[:120]
        timer = extra.pop("timer", None)
        if timer:
            timer.cancel()
            timer.join()
        time.sleep(0.3)
        state = window_state(win)  # what WeChat did to its own window during the run
        leaked = (os.path.getsize(r3.THIEF_LOG) if os.path.exists(r3.THIEF_LOG) else 0) - before
        results.append({"run": i, "condition": cond, "outcome": outcome, "code": code, "reason": reason,
                        "keys": r.keys, "leaked_bytes": leaked, "back_used": counters["back_used"] - back_before,
                        "window_after": state, "secs": round(time.time() - t, 1), **extra})
        trace("reliability.result", **results[-1])
        restore(win)
    by = {}
    for x in results:
        b = by.setdefault(x["condition"], {"runs": 0, "ok": 0, "stops": [], "leaks": 0})
        b["runs"] += 1
        b["ok"] += x["outcome"] in ("reached-and-cleared", "opened")
        b["leaks"] += x["leaked_bytes"] > 0
        if x["code"]:
            b["stops"].append(x["code"])
    trace("reliability.summary", total=len(results), ok=sum(b["ok"] for b in by.values()),
          leaks=sum(x["leaked_bytes"] > 0 for x in results), back_used=counters["back_used"], by_condition=by)
    return 0


def send(args):
    r = Route(d.wechat_app(), x_guard=True)
    try:
        out = with_query(lambda: r.run("File Transfer", "rome test", send=True, store=d.Store(), chat_id="filehelper"))
        trace("done", **out)
        return 0
    except Stop as e:
        trace("stopped", code=e.code, typed=e.typed, reason=e.reason, keys=r.keys)
        return 1


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("send")
    rl = sub.add_parser("reliability")
    rl.add_argument("--contact", required=True)
    rl.add_argument("--raise-on-steal", action="store_true")
    rl.add_argument("--only")
    a = p.parse_args()
    global RAISE_ON_STEAL
    RAISE_ON_STEAL = getattr(a, "raise_on_steal", False)
    return {"send": send, "reliability": reliability}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
