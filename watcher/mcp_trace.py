# -*- coding: utf-8 -*-
# CODESYS Trace in the simulation: a trace object records variables every cycle of a
# task; the data comes back as a table. Uses CODESYS's trace script driver
# (se.trace.create, open_editor().download/start/save), only while CODESYS's own
# simulation runs (mcp_sim checks the device is in simulation mode).
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import os

import mcp_ops
import mcp_sim
from mcp_ops import Ctx, OpError, name_of


import scriptengine as se


def _find(c, name):
    for ch in c.app.get_children(True):
        if name_of(ch).lower() == name.lower():
            return ch
    return None


def _first_task(c):
    for ch in c.app.get_children(True):
        try:
            if ch.is_task:
                return ch
        except Exception:
            pass
    return None


def op_trace_setup(args):
    c = Ctx()
    if not hasattr(se, "trace"):
        raise OpError("unavailable", "This CODESYS has no trace scripting.")
    name = args["name"]
    old = _find(c, name)
    if old is not None:
        old.remove()
    task = args.get("task")
    if not task:
        t = _first_task(c)
        if t is None:
            raise OpError("not_found", "The application has no task to record in.")
        task = name_of(t)
    tr = se.trace.create(c.app, name, task)
    for v in args["variables"]:
        tv = tr.variable_list.add()
        tv.variable_name = v
    if args.get("every_n_cycles"):
        try:
            tr.every_n_cycles = int(args["every_n_cycles"])
        except Exception:
            pass
    return {"name": name, "task": task, "variables": list(args["variables"]), "saved": c.save_if(args)}


def op_trace_record(args):
    c = Ctx()
    mcp_sim._online()  # raises unless the simulation runs
    obj = _find(c, args["name"])
    if obj is None:
        raise OpError("not_found", "No trace named %s. Set it up with trace_setup before starting the simulation." % args["name"])
    if not hasattr(obj, "open_editor"):
        raise OpError("unavailable", "%s is not a trace this CODESYS can record from a script." % args["name"])
    ed = obj.open_editor()
    ed.download()
    ed.start()
    mcp_sim._pause(int(args.get("ms") or 3000))
    path = args["path"]
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    ed.save(path)
    try:
        ed.stop()
    except Exception:
        pass
    return {"path": path}


mcp_ops.OPS["trace.setup"] = mcp_sim._locked(op_trace_setup)
mcp_ops.OPS["trace.record"] = op_trace_record
# The visualization builder changes the project too: not while the simulation runs.
for _op in ("visu.build", "visu.manager"):
    if _op in mcp_ops.OPS:
        mcp_ops.OPS[_op] = mcp_sim._locked(mcp_ops.OPS[_op])
