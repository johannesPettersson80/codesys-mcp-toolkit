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
from mcp_visu import ALARM_CLASS_TYPE, _Modify, _find_child_deep, _find_type, _object_mgr, _type_of


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
    """By type for CODESYS's own objects (their names follow CODESYS's language), else by name."""
    return _find_child_deep(c, name, under)


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
    # The group and its text list share the name: replace both.
    for old in [ch for ch in cfg.get_children(True) if name_of(ch).lower() == name.lower()]:
        try:
            old.remove()
        except Exception:
            pass
    gf = System.Activator.CreateInstance(_alarm_type("AlarmGroupObjectFactory"), True)
    g_grp = mgr.AddObject(h, cfg.guid, Guid.NewGuid(), gf.Create(System.Array[str]([])), name, -1)
    gf.ObjectCreated(h, g_grp)
    classes = {}
    for cls in ("Error", "Warning", "Info"):
        o = _child(c, cls, cfg)
        if o is not None:
            classes[cls] = mgr.GetObjectToRead(h, o.guid).Object
    if len(classes) < 3:
        # A CODESYS in another language names the default classes in it: they come in the
        # order Error, Warning, Info.
        others = [ch for ch in cfg.get_children(True) if _type_of(ch) == ALARM_CLASS_TYPE]
        for cls, ch in zip(("Error", "Warning", "Info"), others):
            if cls not in classes:
                classes[cls] = mgr.GetObjectToRead(h, ch.guid).Object
    if not classes:
        raise OpError("codesys_error", "The Alarm Configuration has no alarm classes.")
    op_type = _alarm_type("DigitalObservation").GetProperty("Comparison").PropertyType
    kinds = {"digital": "DigitalObservation", "upper": "UpperLimitObservation", "lower": "LowerLimitObservation"}
    made = []
    texts = []
    with _Modify(c.proj, _Ref(g_grp)) as grp:
        tl_guid = grp.TextList.MetaObject.ObjectGuid
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
            texts.append((aid, a["text"]))
            made.append(aid)
    # An alarm's message is the row of the group's text list whose ID is the alarm ID. The
    # group's TextList is its own object (the same-named child): written through the group,
    # the rows are lost on save, so it is modified on its own.
    with _Modify(c.proj, _Ref(tl_guid)) as tl:
        for aid, text in texts:
            tl.AddText(text, aid, clr.Reference[bool]())
    return {"group": name, "alarms": made, "classes": sorted(classes.keys()), "saved": c.save_if(args)}


def _texts(c, cfg, name):
    """id -> message of the group's text list (documented text-list scripting)."""
    out = {}
    for ch in cfg.get_children(True):
        if name_of(ch).lower() == name.lower() and hasattr(ch, "rows"):
            try:
                for r in ch.rows:
                    out[to_text(r.id)] = to_text(r.defaulttext)
            except Exception:
                pass
    return out


def op_alarms_list(args):
    """The Alarm Configuration: groups, their alarms (in the order the PLC numbers them), classes and messages."""
    c = Ctx()
    mgr = _object_mgr()
    h = c.proj.handle
    cfg = _child(c, "Alarm Configuration")
    if cfg is None:
        return {"groups": []}
    try:
        group_type = _alarm_type("AlarmGroupObject")
    except OpError:
        group_type = None
    groups = []
    for ch in cfg.get_children(True):
        try:
            o = mgr.GetObjectToRead(h, ch.guid).Object
        except Exception:
            continue
        if not hasattr(o, "AddAlarm") and (group_type is None or not group_type.IsInstanceOfType(o)):
            continue
        name = name_of(ch)
        texts = _texts(c, cfg, name)
        alarms = []
        for a in list(o.Alarms or []):
            ob = a.ObservationType
            aid = to_text(a.ID)
            cls = ""
            try:
                cls = to_text(a.FullAlarmClassName or "")
            except Exception:
                pass
            alarms.append({
                "id": aid,
                "kind": ob.GetType().Name.replace("Observation", "").lower() if ob is not None else "",
                "expression": to_text(getattr(ob, "Expression", "") or ""),
                "comparison": to_text(getattr(ob, "Comparison", "") or ""),
                "compare_to": to_text(getattr(ob, "ExpressionToCompare", "") or ""),
                "cls": cls.split(".")[-1],
                "text": texts.get(aid, ""),
            })
        groups.append({"name": name, "alarms": alarms})
    return {"groups": groups}


def op_textlists_translate(args):
    """Translations into CODESYS's text lists (documented text-list scripting): the
    GlobalTextList, where a visualization looks up its static texts by the text itself,
    and the HMI's alarm group list (alarm messages, matched by their default text)."""
    c = Ctx()
    out = {"languages": [], "rows": 0, "added": 0, "errors": []}
    lists = []
    names = (["GlobalTextList"] if args.get("global", True) else []) + ([args["alarm_group"]] if args.get("alarm_group") else [])
    for name in names:
        for tl in c.proj.find(name, True):
            if hasattr(tl, "rows"):
                lists.append((name, tl))
                break
    for lang, texts in (args.get("translations") or {}).items():
        out["languages"].append(lang)
        for name, tl in lists:
            try:
                tl.addlanguage(lang)
            except Exception:
                pass  # it has the language already
            rows = {}
            for r in tl.rows:
                rows[to_text(r.defaulttext)] = r
            for text, tr in texts.items():
                try:
                    r = rows.get(text)
                    if r is None:
                        if name != "GlobalTextList":
                            continue
                        r = tl.rows.add(text, text)
                        rows[text] = r
                        out["added"] += 1
                    r.setlanguagetext(lang, tr)
                    out["rows"] += 1
                except Exception as e:
                    if len(out["errors"]) < 8:
                        out["errors"].append("%s/%s: %s" % (name, text[:30], to_text(e)[:120]))
    out["saved"] = c.save_if(args)
    return out


def op_visu_users(args):
    """Visualization user groups (no users: their passwords are the engineer's to set)."""
    import System
    c = Ctx()
    vmg = _child(c, "Visualization Manager")
    if vmg is None:
        raise OpError("not_found", "No Visualization Manager: build a visualization first.")
    made = []
    with _Modify(c.proj, vmg) as vm:
        # VisuUserMgmt: the existing user management (with the users the engineer added);
        # it is created only when the project has none yet.
        um = getattr(vm, "VisuUserMgmt", None)
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
mcp_ops.OPS["alarms.list"] = op_alarms_list
mcp_ops.OPS["textlists.translate"] = mcp_sim._locked(op_textlists_translate)
