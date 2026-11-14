# -*- coding: utf-8 -*-
# CODESYS alarm management and visualization user groups, through CODESYS's own
# object factories (the scripting API has no calls for them). Probed on SP21:
# the Alarm Configuration brings its Error/Warning/Info classes and storage; an
# alarm's message is the group text-list row whose ID is the alarm ID.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import mcp_ops
import mcp_sim
from mcp_ops import Ctx, OpError, name_of
from mcp_compat import to_text
from mcp_visu import _Modify, _find_type, _object_mgr


class _Ref(object):
    """Something _Modify can open: just a guid."""

    def __init__(self, guid):
        self.guid = guid


def _alarm_type(n):
    from System import AppDomain
    for a in AppDomain.CurrentDomain.GetAssemblies():
        if a.GetName().Name == "AlarmConfigurationObjects.plugin":
            t = a.GetType("_3S.CoDeSys.AlarmConfigurationObjects." + n)
            if t is not None:
                return t
    raise OpError("unavailable", "This CODESYS has no alarm management (Alarm Configuration) to script.")


def _child(c, name, under=None):
    for ch in (under or c.app).get_children(True):
        if name_of(ch).lower() == name.lower():
            return ch
    return None


def op_alarms_configure(args):
    import System
    import clr
    from System import Guid
    c = Ctx()
    mgr = _object_mgr()
    h = c.proj.handle
    cfg = _child(c, "Alarm Configuration")
    if cfg is None:
        fac = System.Activator.CreateInstance(_alarm_type("AlarmConfigurationObjectFactory"), True)
        g = mgr.AddObject(h, c.app.guid, Guid.NewGuid(), fac.Create(), "Alarm Configuration", -1)
        fac.ObjectCreated(h, g)
        cfg = _child(c, "Alarm Configuration")
    name = args["group"]
    old = _child(c, name, cfg)
    if old is not None:
        old.remove()
    gf = System.Activator.CreateInstance(_alarm_type("AlarmGroupObjectFactory"), True)
    g_grp = mgr.AddObject(h, cfg.guid, Guid.NewGuid(), gf.Create(System.Array[str]([])), name, -1)
    gf.ObjectCreated(h, g_grp)
    classes = {}
    for cls in ("Error", "Warning", "Info"):
        o = _child(c, cls, cfg)
        if o is not None:
            classes[cls] = mgr.GetObjectToRead(h, o.guid).Object
    if not classes:
        raise OpError("codesys_error", "The Alarm Configuration has no alarm classes.")
    op_type = _alarm_type("DigitalObservation").GetProperty("Comparison").PropertyType
    kinds = {"digital": "DigitalObservation", "upper": "UpperLimitObservation", "lower": "LowerLimitObservation"}
    made = []
    with _Modify(c.proj, _Ref(g_grp)) as grp:
        for i, a in enumerate(args["alarms"]):
            aid = str(a.get("id") or i + 1)
            al = System.Activator.CreateInstance(_alarm_type("Alarm"), True)
            al.ID = aid
            ob = System.Activator.CreateInstance(_alarm_type(kinds[a.get("kind") or "digital"]), True)
            ob.Expression = a["expression"]
            ob.Comparison = System.Enum.Parse(op_type, a.get("comparison") or "Equal")
            ob.ExpressionToCompare = to_text(a.get("compare_to") or "TRUE")
            al.ObservationType = ob
            al.SetAlarmClass(classes.get(a.get("cls") or "Error") or list(classes.values())[0], h, c.app.guid)
            grp.AddAlarm(al)
            grp.TextList.AddText(a["text"], aid, clr.Reference[bool]())
            made.append(aid)
    return {"group": name, "alarms": made, "classes": sorted(classes.keys()), "saved": c.save_if(args)}


def op_visu_users(args):
    """Visualization user groups (no users: their passwords are the engineer's to set)."""
    import System
    c = Ctx()
    vmg = _child(c, "Visualization Manager")
    if vmg is None:
        raise OpError("not_found", "No Visualization Manager: build a visualization first.")
    made = []
    with _Modify(c.proj, vmg) as vm:
        um = None
        try:
            um = vm.VisuUserManagement
        except Exception:
            um = None
        if um is None:
            um = vm.CreateVisuUserManagement()
        gl = um.GetGroups()
        have = set()
        try:
            for g in gl:
                have.add(to_text(g.Name).lower())
        except Exception:
            pass
        for name in args["groups"]:
            if name.lower() in have:
                continue
            g = gl.Create(name)
            gl.AddGroupToObject(g, -1, um)
            g.GroupNameIndex = gl.AddGroupNameToGlobalTextList(vmg.guid, name)
            made.append(name)
    t = _find_type("_3S.CoDeSys.VisualObject.VisuUserMgmtLibraryInserter")
    if t is not None:
        System.Activator.CreateInstance(t).TryToInsertVisuUserMgmtLibrary(c.proj.handle, vmg.guid)
    return {"groups": made, "saved": c.save_if(args)}


mcp_ops.OPS["alarms.configure"] = mcp_sim._locked(op_alarms_configure)
mcp_ops.OPS["visu.users"] = mcp_sim._locked(op_visu_users)
