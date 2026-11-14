# -*- coding: utf-8 -*-
# codesys-mcp-toolkit v2 watcher.
#
# Started by the MCP server as:  CODESYS.exe --profile="..." --noUI --runscript="<dir>/watcher.py"
# (with --show-window: no --noUI and CODESYS_MCP_UI=1. The same blocking loop runs: CODESYS
# applies script_prompt_handling only while a script runs, so a timer that runs requests after
# the script returned would show every prompt as a dialog. system.delay() serves the window's
# message loop, so the window keeps painting while the loop waits. Objects that requests
# write or create open in an editor tab there; see mcp_ui.py.)
# Environment (inherited from the server):
#   CODESYS_MCP_DIR         session folder (requests/, results/, heartbeat.json, ready.json, watcher.log)
#   CODESYS_MCP_SCRIPTS     folder holding this file and its modules
#   CODESYS_MCP_PARENT_PID  server PID; the watcher exits when it is gone
#
# Protocol: the server writes requests/<id>.json ({"id","op","args","deadline_ms"}) via tmp+rename.
# The watcher handles one request at a time and writes results/<id>.json
# ({"id","ok","result"} or {"id","ok":false,"error":{"code","message","detail"}}).
# Requests are JSON op names + arguments; no code is ever generated or exec'd.
# Attach mode (CODESYS_MCP_ATTACH=1, see start_attach.py written by the server): run from
# the user's open window; a UI timer polls for requests instead of a blocking loop. The
# launcher runs only this file (the toolkit's own); requests still never become code.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
from __future__ import print_function

import os
import re
import sys
import time
import traceback

SCRIPTS = os.environ.get("CODESYS_MCP_SCRIPTS")
if SCRIPTS and SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mcp_compat import current_pid, now, pid_alive, read_json, remove_file, retry_fs, to_text, write_json_atomic  # noqa: E402

SESSION = os.environ["CODESYS_MCP_DIR"]
PARENT_PID = int(os.environ.get("CODESYS_MCP_PARENT_PID") or "0")
REQ_DIR = os.path.join(SESSION, "requests")
RES_DIR = os.path.join(SESSION, "results")
HEARTBEAT = os.path.join(SESSION, "heartbeat.json")
READY = os.path.join(SESSION, "ready.json")
LOG = os.path.join(SESSION, "watcher.log")

DIALOG = os.path.join(SESSION, "dialog.json")

PID = current_pid()
STATE = {"count": 0, "last_beat": 0.0, "busy_since": None, "op": None}

# A dialog must stay up this long before the server is told, so brief windows don't count.
DIALOG_GRACE_S = 10.0

# With the window shown (--show-window), these ops open the object they wrote in an editor.
UI = {"on": False}
FOLLOW_OPS = ("object.write", "object.create")


def follow_in_editor(ops_mod, result):
    """Opens the object a request wrote in its editor, so the window shows the code."""
    path = (result or {}).get("path")
    if not path or (result or {}).get("kind") == "folder":
        return
    try:
        import scriptengine as se
        import mcp_ui
        obj = ops_mod.Ctx().resolve(path)
        log("editor %s: %s" % (mcp_ui.open_editor(se, obj), path))
    except BaseException as e:
        log("editor not opened for %s: %s" % (path, to_text(e)))


def log(msg):
    try:
        f = open(LOG, "a")
        try:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), to_text(msg).encode("ascii", "replace").decode("ascii")))
        finally:
            f.close()
    except Exception:
        pass


def beat(state, op=None, rid=None, deadline_ms=None):
    # A heartbeat that cannot be written (file held open past the retries) must not
    # kill the watcher: log it and go on. If it keeps failing, the server sees a
    # stale heartbeat and reports the watcher as hung, which is the right signal.
    t = now()
    try:
        write_json_atomic(HEARTBEAT, {
            "pid": PID, "ts": t, "state": state, "op": op, "id": rid,
            "deadline": (t + deadline_ms / 1000.0) if deadline_ms else None,
            "count": STATE["count"],
        })
    except Exception as e:
        if t - STATE.get("last_beat_err", 0.0) > 30.0:
            STATE["last_beat_err"] = t
            log("heartbeat write failed (%s): %s\n%s" % (state, to_text(e), to_text(traceback.format_exc())))
    STATE["last_beat"] = t


def setup_prompts(se):
    # Never block on a modal dialog: suppress with defaults and log them.
    # SP21 only has the old prompt_handling; newer versions have script_prompt_handling.
    try:
        se.system.script_prompt_handling = se.ScriptPromptHandling.LogPrompts
        return "script_prompt_handling=LogPrompts"
    except Exception:
        pass
    try:
        se.system.prompt_handling = se.PromptHandling.LogSimplePrompts
        return "prompt_handling=LogSimplePrompts"
    except Exception as e:
        return "prompt handling not set: %s" % e


def scripting_version():
    # In CODESYS, sys.version ends in "ScriptEngine.plugin 4.2.0.0".
    m = re.search(r"ScriptEngine\.plugin\s+([0-9.]+)", sys.version)
    return m.group(1) if m else None


def find_dialog(ui=False):
    # A session without a UI has no open forms and no main window (checked on SP21 and
    # SP22), so a modal form or a main window means CODESYS is waiting for an answer.
    # With a window (ui), only a modal form counts.
    from System.Windows.Forms import Application
    from System.Diagnostics import Process
    for f in Application.OpenForms:
        if f.Modal:
            return to_text(f.Text) or "(untitled)"
    if ui:
        return None
    return to_text(Process.GetCurrentProcess().MainWindowTitle) or None


def watch_dialogs(ui=False):
    # Runs beside the request loop. A dialog blocks that loop for good and nobody can
    # answer it in a session without a window, so tell the server (dialog.json).
    # With a window the user can answer it; the server is still told, so the call ends.
    import clr
    clr.AddReference("System.Windows.Forms")
    title, since, reported, failed = None, 0.0, False, False
    while True:
        time.sleep(1.0)
        busy = STATE["busy_since"]
        current = None
        if busy is not None and now() - busy > 2.0:
            try:
                current = find_dialog(ui)
            except Exception as e:  # e.g. the form list changed while it was read
                if not failed:
                    log("dialog check failed: %s" % to_text(e))
                failed = True
        if current != title:
            title, since = current, now()
            if current:
                log("dialog up during %s: %s" % (STATE["op"], current))
            elif reported:
                remove_file(DIALOG)
                reported = False
        elif current and not reported and now() - since >= DIALOG_GRACE_S:
            write_json_atomic(DIALOG, {"title": current, "op": STATE["op"]})
            reported = True


def start_dialog_watch(ui=False):
    import threading

    def run():
        try:
            watch_dialogs(ui)
        except BaseException as e:
            log("dialog watch stopped: %s" % to_text(e))
    t = threading.Thread(target=run)
    t.daemon = True
    t.start()


def sleep_ms(se, ms):
    delay = getattr(getattr(se, "system", None), "delay", None)
    if delay is not None and not hasattr(se, "FAKE"):
        try:
            delay(ms)
            return
        except Exception:
            pass
    time.sleep(ms / 1000.0)


def next_request():
    try:
        names = sorted(n for n in os.listdir(REQ_DIR) if n.endswith(".json"))
    except OSError:
        return None
    return names[0] if names else None


def handle(ops_mod, fname):
    path = os.path.join(REQ_DIR, fname)
    rid = fname[:-5]
    try:
        # Another process (an antivirus scan, the indexer) can hold a new file for a moment.
        req = retry_fs(read_json, path)
    except Exception as e:
        remove_file(path)
        write_json_atomic(os.path.join(RES_DIR, rid + ".json"), {
            "id": rid, "ok": False, "error": {"code": "bad_request", "message": "Unreadable request: %s" % e}})
        return True
    remove_file(path)
    rid = req.get("id") or rid
    op = req.get("op")
    args = req.get("args") or {}
    STATE["count"] += 1
    beat("busy", op, rid, req.get("deadline_ms"))
    started = now()
    STATE["op"] = op
    STATE["busy_since"] = started
    stop = False
    if op == "shutdown":
        res = {"id": rid, "ok": True, "result": {"bye": True}}
        stop = True
    else:
        fn = ops_mod.OPS.get(op)
        if fn is None:
            res = {"id": rid, "ok": False, "error": {"code": "unknown_op", "message": "Unknown op: %s" % op}}
        else:
            try:
                res = {"id": rid, "ok": True, "result": fn(args)}
                if UI["on"] and op in FOLLOW_OPS:
                    follow_in_editor(ops_mod, res["result"])
            except ops_mod.OpError as e:
                res = {"id": rid, "ok": False, "error": {"code": e.code, "message": to_text(e.message)}}
            except BaseException as e:  # IronPython: KeyboardInterrupt is not an Exception
                res = {"id": rid, "ok": False, "error": {
                    "code": "codesys_error", "message": to_text(e) or e.__class__.__name__,
                    "detail": to_text(traceback.format_exc())}}
    STATE["busy_since"] = None
    res["ms"] = int((now() - started) * 1000)
    # Go idle before publishing the result: once the server sees the result it may
    # read the heartbeat right away, and it must not find this op still "busy".
    beat("idle")
    write_json_atomic(os.path.join(RES_DIR, rid + ".json"), res)
    log("%s %s %s %dms" % (rid, op, "ok" if res.get("ok") else res["error"]["code"], res["ms"]))
    return not stop


def main(ui=False):
    UI["on"] = ui
    for d in (REQ_DIR, RES_DIR):
        if not os.path.isdir(d):
            os.makedirs(d)
    log("watcher starting pid=%s parent=%s python=%s%s" % (PID, PARENT_PID, sys.version.split()[0], " (window shown)" if ui else ""))
    import scriptengine as se
    import mcp_ops
    import mcp_sim  # noqa: F401 (adds its operations to mcp_ops.OPS)
    prompts = setup_prompts(se)
    log(prompts)
    if not hasattr(se, "FAKE"):
        start_dialog_watch(ui)
    beat("idle")
    write_json_atomic(READY, {"pid": PID, "ts": now(), "python": sys.version.split()[0], "prompts": prompts, "scripting": scripting_version(), "window": ui})
    last_parent_check = 0.0
    while True:
        t = now()
        if PARENT_PID and t - last_parent_check > 2.0:
            last_parent_check = t
            if not pid_alive(PARENT_PID):
                log("parent %s gone; exiting" % PARENT_PID)
                break
        fname = next_request()
        if fname:
            if not handle(mcp_ops, fname):
                log("shutdown requested")
                break
            continue
        if t - STATE["last_beat"] > 1.0:
            beat("idle")
        sleep_ms(se, 40)
    beat("stopped")


def main_attach():
    # Attach mode: the user's own window runs this script (Tools > Scripting > Execute
    # Script File). A blocking loop would freeze their window, so a WinForms timer polls
    # for requests on the UI thread and the script returns at once. The window is only
    # busy while a request runs. No dialog watch: a window and dialogs are expected here.
    for d in (REQ_DIR, RES_DIR):
        if not os.path.isdir(d):
            os.makedirs(d)
    log("attach watcher starting pid=%s python=%s" % (PID, sys.version.split()[0]))
    # This runs on the user's UI thread: never block it for seconds on a busy file.
    import mcp_compat
    mcp_compat.FS_RETRY_S = 0.3
    import clr
    clr.AddReference("System.Windows.Forms")
    from System.Windows.Forms import Timer
    import __builtin__
    import scriptengine as se
    import mcp_ops
    import mcp_sim  # noqa: F401 (adds its operations to mcp_ops.OPS)
    prompts = setup_prompts(se)
    log(prompts)
    old = getattr(__builtin__, "_mcp_attach_timer", None)
    if old is not None:
        old.Stop()  # started twice: the new script takes over
    stop_flag = os.path.join(SESSION, "stop.flag")
    busy = {"in_tick": False}

    def on_tick(sender, args):
        # Handling a request can pump messages (waits inside operations), which fires
        # another tick: ignore it until the request is done.
        if busy["in_tick"]:
            return
        busy["in_tick"] = True
        try:
            if os.path.exists(stop_flag):
                remove_file(stop_flag)
                sender.Stop()
                beat("stopped")
                log("stop.flag found; attach watcher stopped")
                return
            fname = next_request()
            if fname:
                if not handle(mcp_ops, fname):
                    sender.Stop()
                    beat("stopped")
                    log("shutdown requested")
            elif now() - STATE["last_beat"] > 1.0:
                beat("idle")
        except BaseException as e:
            log("tick failed: %s" % to_text(traceback.format_exc()))
        finally:
            busy["in_tick"] = False

    timer = Timer()
    timer.Interval = 100
    timer.Tick += on_tick
    timer.Start()
    __builtin__._mcp_attach_timer = timer  # keep it alive after this script returns
    beat("idle")
    write_json_atomic(READY, {"pid": PID, "ts": now(), "python": sys.version.split()[0], "prompts": prompts, "scripting": scripting_version(), "attach": True})
    log("attach watcher running")


try:
    if os.environ.get("CODESYS_MCP_ATTACH") == "1":
        main_attach()
    else:
        main(ui=os.environ.get("CODESYS_MCP_UI") == "1")
except BaseException:
    log("watcher crashed: " + traceback.format_exc())
    try:
        beat("crashed")
    except Exception:
        pass
