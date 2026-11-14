# -*- coding: utf-8 -*-
# Breakpoints and stepping in CODESYS's own simulation, through CODESYS's breakpoint
# manager (the service behind its Debug menu). Only while the simulation runs
# (mcp_sim checks the device is in simulation mode).
#
# Positions are CODESYS's statement positions for an object. Their low 32 bits are
# the implementation line plus a per-object offset; the server maps lines to them.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import mcp_ops
import mcp_sim
from mcp_ops import Ctx, OpError, name_of
from mcp_compat import to_text

import scriptengine as se

BPS = {}


def _find_type(name):
    try:
        from System import AppDomain
    except ImportError:
        raise OpError("unavailable", "Debugging needs CODESYS.")
    for asm in AppDomain.CurrentDomain.GetAssemblies():
        try:
            t = asm.GetType(name)
        except Exception:
            t = None
        if t is not None:
            return t
    return None


def _bpm():
    from System.Reflection import BindingFlags
    for tname in ("_3S.CoDeSys.MemoryTools.APEnvironment",):
        t = _find_type(tname)
        if t is not None:
            p = t.GetProperty("BreakpointManager", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            if p is not None:
                v = p.GetValue(None, None)
                if v is not None:
                    return v
    raise OpError("unavailable", "This CODESYS doesn't offer breakpoints to scripts.")


def _hit_always():
    import System
    t = _find_type("_3S.CoDeSys.Core.Online.HitCountCondition")
    if t is None:
        raise OpError("unavailable", "Breakpoint conditions not found.")
    names = list(System.Enum.GetNames(t))
    return System.Enum.Parse(t, "Always" if "Always" in names else names[0])


def _impl_text(obj):
    try:
        return to_text(obj.textual_implementation.text)
    except Exception:
        return ""


def op_debug_positions(args):
    c = Ctx()
    obj = c.resolve(args["path"])
    r = _bpm().GetBreakpointPositions(c.app.guid, c.proj.handle, obj.guid)
    ok = bool(r[0])
    return {"path": c.path_of(obj), "ok": ok, "positions": [int(p) for p in r[1]] if ok else [], "lengths": [int(n) for n in r[2]] if ok else [], "implementation": _impl_text(obj)}


def op_debug_set(args):
    import System
    c = Ctx()
    mcp_sim._online()
    obj = c.resolve(args["path"])
    bpm = _bpm()
    bp = bpm.CreateBreakpoint(c.app.guid, c.proj.handle, obj.guid, System.Int64(int(args["position"])), args["instance"], None, _hit_always(), 0)
    bpm.SetBreakpoint(bp)
    bpm.EnableBreakpoint(bp)
    key = "%s@%s" % (c.path_of(obj), args["position"])
    BPS[key] = bp
    return {"id": key}


def op_debug_set_data(args):
    """A data breakpoint: halt when a variable is written (optionally only when a condition holds)."""
    import System
    c = Ctx()
    mcp_sim._online()
    bpm = _bpm()
    expr = args["expression"]
    tasks = System.Array[str](args.get("tasks") or [])
    try:
        bp = bpm.CreateDataBreakpoint(c.app.guid, c.proj.handle, expr, int(args.get("size") or 0), tasks, _hit_always(), 0, False, args.get("condition") or "", "", "")
    except AttributeError:
        raise OpError("unavailable", "This CODESYS has no data breakpoints for scripts.")
    bpm.SetBreakpoint(bp)
    bpm.EnableBreakpoint(bp)
    key = "data:%s" % expr
    BPS[key] = bp
    # With size 0 CODESYS keeps the breakpoint disabled; the server passes the variable's size.
    return {"id": key, "enabled": bool(bp.IsEnabled)}


def _call_stack(c):
    """The call stack while halted: each entry's POU and instance, innermost first."""
    out = []
    try:
        from System.Reflection import BindingFlags
        om = None
        for tname in ("_3S.CoDeSys.MemoryTools.APEnvironment", "_3S.CoDeSys.VisualEditor.APEnvironment", "_3S.CoDeSys.RecipeManObject.APEnvironment"):
            t = _find_type(tname)
            p = t.GetProperty("OnlineMgr", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static) if t is not None else None
            if p is not None:
                om = p.GetValue(None, None)
                if om is not None:
                    break
        if om is None:
            return []
        app = om.GetApplication(c.app.guid)
        for e in list(app.CallStack or []):
            # LocationInformation.EditorInstancePath: 'PLCWinNT.Application.PLC_PRG.fbCount';
            # the task's own frames ('CallTask__MainTask', '__cycle__code__MainTask') are left out.
            info = e.LocationInformation
            path = to_text(info.EditorInstancePath or "")
            if not path or path.split(".")[-1].startswith("__") or path.split(".")[-1].startswith("CallTask__"):
                continue
            out.append({"instance": path})
    except Exception as ex:
        out.append({"error": to_text(ex)[:160]})
    return out


def op_debug_clear(args):
    mcp_sim._online()
    bpm = _bpm()
    keys = list(BPS.keys()) if not args.get("id") else [args["id"]]
    for k in keys:
        bp = BPS.pop(k, None)
        if bp is not None:
            try:
                bpm.ClearBreakpoint(bp)
            except Exception:
                pass
    return {"cleared": keys}


def op_debug_status(args):
    c = Ctx()
    online = mcp_sim._online()
    state = to_text(online.application_state)
    out = {"state": state, "breakpoints": sorted(BPS.keys())}
    if "halt" in state.lower():
        r = _bpm().GetCurrentStatement(c.app.guid)
        try:
            if r[0]:
                guid = to_text(r[2])
                path = None
                for ch in c.app.get_children(True):
                    if to_text(ch.guid) == guid:
                        path = c.path_of(ch)
                        obj = ch
                        break
                out["at"] = {"path": path, "position": int(r[3]), "instance": to_text(r[5])}
                if path:
                    pos = op_debug_positions({"path": path})
                    out["at"]["positions"] = pos["positions"]
                    out["at"]["implementation"] = pos["implementation"]
        except Exception as e:
            out["at_error"] = to_text(e)
        out["call_stack"] = _call_stack(c)
    return out


def op_debug_step(args):
    c = Ctx()
    mcp_sim._online()
    bpm = _bpm()
    kind = args.get("kind") or "over"
    {"over": bpm.StepOver, "into": bpm.StepInto, "out": bpm.StepOut}[kind](c.app.guid)
    mcp_sim._pause(300)
    return op_debug_status({})


def op_debug_continue(args):
    online = mcp_sim._online()
    if to_text(online.application_state).lower() != "run":
        online.start()
        mcp_sim._pause(200)
    return {"state": to_text(online.application_state)}


mcp_ops.OPS.update({
    "debug.positions": op_debug_positions,
    "debug.set": op_debug_set,
    "debug.set_data": op_debug_set_data,
    "debug.clear": op_debug_clear,
    "debug.status": op_debug_status,
    "debug.step": op_debug_step,
    "debug.continue": op_debug_continue,
})

# Breakpoints end with the simulation: forget them when it stops.
_release = mcp_sim._release


def _release_and_forget():
    BPS.clear()
    _release()


mcp_sim._release = _release_and_forget
