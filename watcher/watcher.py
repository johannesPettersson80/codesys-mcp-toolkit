# -*- coding: utf-8 -*-
# codesys-mcp-toolkit v2 watcher.
#
# Started by the MCP server as:  CODESYS.exe --profile="..." --noUI --runscript="<dir>/watcher.py"
# Environment (inherited from the server):
#   CODESYS_MCP_DIR         session folder (requests/, results/, heartbeat.json, ready.json, watcher.log)
#   CODESYS_MCP_SCRIPTS     folder holding this file and its modules
#   CODESYS_MCP_PARENT_PID  server PID; the watcher exits when it is gone
#
# Protocol: the server writes requests/<id>.json ({"id","op","args","deadline_ms"}) via tmp+rename.
# The watcher handles one request at a time and writes results/<id>.json
# ({"id","ok","result"} or {"id","ok":false,"error":{"code","message","detail"}}).
# Requests are JSON op names + arguments; no code is ever generated or exec'd.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
from __future__ import print_function

import os
import sys
import time
import traceback

SCRIPTS = os.environ.get("CODESYS_MCP_SCRIPTS")
if SCRIPTS and SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mcp_compat import current_pid, now, pid_alive, read_json, remove_file, to_text, write_json_atomic  # noqa: E402

SESSION = os.environ["CODESYS_MCP_DIR"]
PARENT_PID = int(os.environ.get("CODESYS_MCP_PARENT_PID") or "0")
REQ_DIR = os.path.join(SESSION, "requests")
RES_DIR = os.path.join(SESSION, "results")
HEARTBEAT = os.path.join(SESSION, "heartbeat.json")
READY = os.path.join(SESSION, "ready.json")
LOG = os.path.join(SESSION, "watcher.log")

PID = current_pid()
STATE = {"count": 0, "last_beat": 0.0}


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
        log("heartbeat write failed (%s): %s" % (state, to_text(e)))
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
        req = read_json(path)
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
            except ops_mod.OpError as e:
                res = {"id": rid, "ok": False, "error": {"code": e.code, "message": to_text(e.message)}}
            except BaseException as e:  # IronPython: KeyboardInterrupt is not an Exception
                res = {"id": rid, "ok": False, "error": {
                    "code": "codesys_error", "message": to_text(e) or e.__class__.__name__,
                    "detail": to_text(traceback.format_exc())}}
    res["ms"] = int((now() - started) * 1000)
    # Go idle before publishing the result: once the server sees the result it may
    # read the heartbeat right away, and it must not find this op still "busy".
    beat("idle")
    write_json_atomic(os.path.join(RES_DIR, rid + ".json"), res)
    log("%s %s %s %dms" % (rid, op, "ok" if res.get("ok") else res["error"]["code"], res["ms"]))
    return not stop


def main():
    for d in (REQ_DIR, RES_DIR):
        if not os.path.isdir(d):
            os.makedirs(d)
    log("watcher starting pid=%s parent=%s python=%s" % (PID, PARENT_PID, sys.version.split()[0]))
    import scriptengine as se
    import mcp_ops
    prompts = setup_prompts(se)
    log(prompts)
    beat("idle")
    write_json_atomic(READY, {"pid": PID, "ts": now(), "python": sys.version.split()[0], "prompts": prompts})
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


try:
    main()
except BaseException:
    log("watcher crashed: " + traceback.format_exc())
    try:
        beat("crashed")
    except Exception:
        pass
