# -*- coding: utf-8 -*-
# Operation handlers for the codesys-mcp-toolkit watcher.
# Runs inside CODESYS (IronPython 2.7) and under CPython 3 with a fake
# scriptengine in tests. Keep this file ASCII-only.
#
# SAFETY: this module must never use online/login/download APIs. The test
# suite greps for them. Simulation work happens in truST, never on a PLC.
from __future__ import print_function

import os
import re

import scriptengine as se

from mcp_compat import to_text


class OpError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# Object type GUIDs (verified against CODESYS V3.5 SP21). Names are
# localised by CODESYS ("Taskkonfiguration"), so kinds come from GUIDs only.
GUID_KIND = {
    "6f9dac99-8de1-4efc-8465-68ac443b7d08": "pou",
    "f8a58466-d7f6-439f-bbb8-d4600e41d099": "method",
    "5a3b8626-d3e9-4f37-98b5-66420063d91e": "property",
    "792f2eb6-721e-4e64-ba20-bc98351056db": "accessor",
    "8ac092e5-3128-4e26-9e7e-11016c6684f2": "action",
    "2db5746d-d284-4425-9f7f-2663a34b0ebc": "dut",
    "ffbfa93a-b94d-45fc-a329-229860183b1d": "gvl",
    "6654496c-404d-479a-aad2-8551054e5f1e": "interface",
    "f89f7675-27f1-46b3-8abb-b7da8e774ffd": "interface_method",
    "ae1de277-a207-4a28-9efb-456c06bd52f3": "task_config",
    "98a2708a-9b18-4f31-82ed-a1465b24fa2d": "task",
    "413e2a7d-adb1-4d2c-be29-6ae6e4fab820": "task_call",
    "adb5cb65-8e1d-4a00-b70a-375ea27582f3": "library_manager",
}

SCRIPT_MESSAGE_CATEGORY = "194b48a9-ab51-43ae-b9a9-51d3edaaddf3"

_LEAD = r"^\s*(?:(?:\{[^}]*\}|//[^\n]*\n|\(\*.*?\*\))\s*)*"
_HEADER_RE = re.compile(_LEAD + r"(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|TYPE|VAR_GLOBAL)\b", re.S | re.I)
_DUT_RE = re.compile(_LEAD + r"TYPE\s+\w+\s*(?:EXTENDS\s+[\w.]+\s*)?:\s*(STRUCT|UNION|\()?", re.S | re.I)


# ---------------------------------------------------------------- helpers

def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def guid_of(obj):
    return (to_text(_safe(lambda: obj.guid)) or "").strip("{}").lower()


def name_of(obj):
    return to_text(obj.get_name())


def children(obj):
    return list(obj.get_children(False))


def decl_of(obj):
    if _safe(lambda: obj.has_textual_declaration, False):
        return to_text(obj.textual_declaration.text)
    return None


def impl_of(obj):
    if _safe(lambda: obj.has_textual_implementation, False):
        return to_text(obj.textual_implementation.text)
    return None


def header_keyword(decl):
    m = _HEADER_RE.match(decl or "")
    return m.group(1).upper() if m else None


def subkind(kind, decl):
    if kind == "pou":
        kw = header_keyword(decl)
        return {"PROGRAM": "program", "FUNCTION_BLOCK": "function_block", "FUNCTION": "function"}.get(kw)
    if kind == "dut":
        m = _DUT_RE.match(decl or "")
        if not m:
            return None
        tok = (m.group(1) or "").upper()
        return {"STRUCT": "struct", "UNION": "union", "(": "enum"}.get(tok, "alias")
    return None


def kind_of(obj, app_guid=None):
    k = GUID_KIND.get((to_text(_safe(lambda: obj.type)) or "").strip("{}").lower())
    if k:
        return k
    if app_guid and guid_of(obj) == app_guid:
        return "application"
    if _safe(lambda: obj.is_folder, False):
        return "folder"
    if _safe(lambda: obj.is_device, False):
        return "device"
    return "other"


def is_st(obj, kind):
    """True for text objects, False for graphical bodies (SFC/CFC/LD/FBD/IL)."""
    if kind in ("pou", "method", "action", "accessor"):
        return bool(_safe(lambda: obj.has_textual_implementation, False))
    if kind in ("dut", "gvl", "interface", "interface_method", "property"):
        return True
    return None


def chain_names(obj):
    """Names from the top of the project down to obj."""
    names = []
    cur = obj
    for _ in range(64):
        if cur is None:
            break
        nm = _safe(lambda: cur.get_name())
        if nm is None:
            break
        names.insert(0, to_text(nm))
        cur = _safe(lambda: cur.parent)
    return names


class Ctx(object):
    def __init__(self, require_project=True):
        self.proj = se.projects.primary
        if self.proj is None and require_project:
            raise OpError("no_project", "No project is open. Call open_project first.")
        self.app = _safe(lambda: self.proj.active_application) if self.proj is not None else None
        self.app_guid = guid_of(self.app) if self.app is not None else None
        self.app_chain = chain_names(self.app) if self.app is not None else []

    def rel(self, names):
        n = len(self.app_chain)
        if n and names[:n] == self.app_chain and len(names) > n:
            return "/".join(names[n:])
        return "/" + "/".join(names)

    def resolve(self, path):
        path = (path or "").strip()
        if path in ("", ".", "/"):
            if path == "/" or self.app is None:
                raise OpError("bad_path", "Give an object path, e.g. 'PLC_PRG' or 'FB_Pump/Start'.")
            return self.app
        absolute = path.startswith("/")
        parts = [p for p in path.split("/") if p]
        if absolute or self.app is None:
            base_children = children(self.proj)
            cur = None
        else:
            if parts and parts[0].lower() == name_of(self.app).lower() and _find(children(self.app), parts[0]) is None:
                parts = parts[1:]
            base_children = None
            cur = self.app
        walked = []
        for part in parts:
            pool = base_children if cur is None else children(cur)
            nxt = _find(pool, part)
            if nxt is None:
                where = "/".join(walked) or ("project root" if (absolute or self.app is None) else name_of(self.app))
                hint = ", ".join(sorted(name_of(c) for c in pool)[:25])
                raise OpError("not_found", "No object '%s' under %s. Children there: %s" % (part, where, hint or "(none)"))
            walked.append(name_of(nxt))
            cur = nxt
        return cur

    def path_of(self, obj):
        return self.rel(chain_names(obj))

    def save_if(self, args):
        if args.get("save"):
            self.proj.save()
            return True
        return False


def _find(objs, name):
    for c in objs:
        if name_of(c) == name:
            return c
    low = name.lower()
    for c in objs:
        if name_of(c).lower() == low:
            return c
    return None


def _norm(p):
    return os.path.normcase(os.path.abspath(p)) if p else p


def _project_info(proj, ctx=None):
    ctx = ctx or Ctx()
    return {
        "path": to_text(_safe(lambda: proj.path)),
        "dirty": bool(_safe(lambda: proj.dirty, False)),
        "application": name_of(ctx.app) if ctx.app is not None else None,
    }


def _node(ctx, obj, names, depth, with_text):
    kind = kind_of(obj, ctx.app_guid)
    decl = decl_of(obj) if (with_text or kind in ("pou", "dut")) else None
    node = {
        "path": ctx.rel(names),
        "name": names[-1],
        "kind": kind,
        "depth": depth,
    }
    sk = subkind(kind, decl)
    if sk:
        node["sub"] = sk
    st = is_st(obj, kind)
    if st is not None:
        node["st"] = st
    if with_text:
        if decl is not None:
            node["declaration"] = decl
        impl = impl_of(obj)
        if impl is not None:
            node["implementation"] = impl
    return node


def _walk(ctx, root, root_names, max_depth, with_text, out):
    def rec(obj, names, depth):
        for c in children(obj):
            cn = names + [name_of(c)]
            out.append(_node(ctx, c, cn, depth, with_text))
            if max_depth is None or depth < max_depth:
                rec(c, cn, depth + 1)
    rec(root, root_names, 0)


# ---------------------------------------------------------------- ops

def op_ping(args):
    info = {"engine": "codesys" if not hasattr(se, "FAKE") else "fake"}
    proj = _safe(lambda: se.projects.primary)
    info["project"] = to_text(_safe(lambda: proj.path)) if proj is not None else None
    return info


def op_project_open(args):
    path = args["path"]
    cur = se.projects.primary
    if cur is not None:
        if _norm(to_text(_safe(lambda: cur.path))) == _norm(path):
            info = _project_info(cur)
            info["reused"] = True
            return info
        if _safe(lambda: cur.dirty, False) and not args.get("discard_changes"):
            raise OpError("unsaved_changes", "Project %s has unsaved changes. Save it, or pass discardChanges." % to_text(cur.path))
        cur.close()
    if not os.path.exists(path):
        raise OpError("not_found", "Project file not found: %s" % path)
    flags = None
    try:
        flags = se.VersionUpdateFlags.NoUpdates | se.VersionUpdateFlags.SilentMode
    except AttributeError:
        flags = None
    proj = se.projects.open(path, update_flags=flags) if flags is not None else se.projects.open(path)
    if proj is None:
        raise OpError("open_failed", "CODESYS returned no project for %s" % path)
    return _project_info(proj)


def op_project_create_empty(args):
    path = args["path"]
    if os.path.exists(path):
        raise OpError("exists", "File already exists: %s" % path)
    cur = se.projects.primary
    if cur is not None:
        if _safe(lambda: cur.dirty, False) and not args.get("discard_changes"):
            raise OpError("unsaved_changes", "Project %s has unsaved changes." % to_text(cur.path))
        cur.close()
    proj = se.projects.create(path, True)
    proj.save()
    return _project_info(proj, Ctx())


def op_project_info(args):
    c = Ctx(require_project=False)
    if c.proj is None:
        return {"open": False}
    info = _project_info(c.proj, c)
    info["open"] = True
    return info


def op_project_save(args):
    c = Ctx()
    c.proj.save()
    return _project_info(c.proj, c)


def op_project_close(args):
    c = Ctx(require_project=False)
    if c.proj is None:
        return {"closed": False}
    if _safe(lambda: c.proj.dirty, False) and not args.get("discard_changes"):
        raise OpError("unsaved_changes", "Project has unsaved changes. Save it, or pass discardChanges.")
    c.proj.close()
    return {"closed": True}


def op_tree(args):
    c = Ctx()
    out = []
    if args.get("root"):
        root = c.resolve(args["root"])
        names = chain_names(root)
    elif args.get("whole_project") or c.app is None:
        root, names = c.proj, []
    else:
        root, names = c.app, c.app_chain
    _walk(c, root, names, args.get("max_depth"), False, out)
    return {"nodes": out, "application": name_of(c.app) if c.app is not None else None}


def op_objects_read(args):
    c = Ctx()
    res = []
    for p in args.get("paths", []):
        try:
            obj = c.resolve(p)
            res.append(_node(c, obj, chain_names(obj), 0, True))
        except OpError as e:
            res.append({"path": p, "error": e.message, "code": e.code})
    return {"objects": res}


def op_object_write(args):
    c = Ctx()
    obj = c.resolve(args["path"])
    kind = kind_of(obj, c.app_guid)
    if "declaration" in args and args["declaration"] is not None:
        if not _safe(lambda: obj.has_textual_declaration, False):
            raise OpError("no_declaration", "%s (%s) has no textual declaration." % (args["path"], kind))
        obj.textual_declaration.replace(args["declaration"])
    if "implementation" in args and args["implementation"] is not None:
        if not _safe(lambda: obj.has_textual_implementation, False):
            raise OpError("not_st", "%s (%s) has no textual (ST) implementation; v2 edits ST only." % (args["path"], kind))
        obj.textual_implementation.replace(args["implementation"])
    return {"path": c.path_of(obj), "kind": kind, "saved": c.save_if(args)}


def op_object_create(args):
    c = Ctx()
    parent = c.resolve(args.get("parent") or ".")
    kind = args["kind"]
    name = args["name"]
    rt = args.get("return_type")
    if kind in ("program", "function_block", "function"):
        pt = {"program": se.PouType.Program, "function_block": se.PouType.FunctionBlock,
              "function": se.PouType.Function}[kind]
        if kind == "function":
            if not rt:
                raise OpError("bad_args", "A function needs returnType.")
            obj = parent.create_pou(name, pt, return_type=rt)
        else:
            obj = parent.create_pou(name, pt)
    elif kind == "method":
        obj = parent.create_method(name, rt) if rt else parent.create_method(name)
    elif kind == "property":
        if not rt:
            raise OpError("bad_args", "A property needs returnType.")
        obj = parent.create_property(name, rt)
    elif kind == "action":
        obj = parent.create_action(name)
    elif kind == "interface":
        base = args.get("base_interfaces")
        try:
            # Empty base list: no implicit __System.IQueryInterface (truST cannot parse it).
            obj = parent.create_interface(name, base if base else "")
        except Exception:
            obj = parent.create_interface(name)
    elif kind == "dut":
        dt = {"struct": se.DutType.Structure, "enum": se.DutType.Enumeration,
              "union": se.DutType.Union, "alias": se.DutType.Alias}[args.get("dut_type") or "struct"]
        obj = parent.create_dut(name, dt)
    elif kind == "gvl":
        obj = parent.create_gvl(name)
    elif kind == "folder":
        obj = parent.create_folder(name)
    else:
        raise OpError("bad_args", "Unknown kind %s" % kind)
    if args.get("declaration") is not None:
        obj.textual_declaration.replace(args["declaration"])
    if args.get("implementation") is not None:
        if not _safe(lambda: obj.has_textual_implementation, False):
            raise OpError("not_st", "Created %s has no textual implementation." % name)
        obj.textual_implementation.replace(args["implementation"])
    return {"path": c.path_of(obj), "kind": kind_of(obj, c.app_guid), "saved": c.save_if(args)}


def op_object_delete(args):
    c = Ctx()
    obj = c.resolve(args["path"])
    path = c.path_of(obj)
    obj.remove()
    return {"path": path, "saved": c.save_if(args)}


def op_object_rename(args):
    c = Ctx()
    obj = c.resolve(args["path"])
    obj.rename(args["new_name"])
    return {"path": c.path_of(obj), "saved": c.save_if(args)}


def op_export(args):
    c = Ctx()
    out = []
    if args.get("root"):
        root = c.resolve(args["root"])
        names = chain_names(root)
    elif c.app is not None:
        root, names = c.app, c.app_chain
    else:
        root, names = c.proj, []
    _walk(c, root, names, None, True, out)
    return {"nodes": out, "application": name_of(c.app) if c.app is not None else None}


def op_build(args):
    c = Ctx()
    if c.app is None:
        raise OpError("no_application", "The project has no active application to build.")
    c.app.build()
    msgs = []
    for cat in se.system.get_message_categories(True):
        if (to_text(cat) or "").strip("{}").lower() == SCRIPT_MESSAGE_CATEGORY:
            continue
        desc = to_text(_safe(lambda: se.system.get_message_category_description(cat), ""))
        for m in se.system.get_message_objects(cat):
            obj = _safe(lambda: m.object)
            msgs.append({
                "category": desc,
                "severity": to_text(_safe(lambda: m.severity, "")),
                "text": to_text(_safe(lambda: m.text, "")),
                "prefix": to_text(_safe(lambda: m.prefix)),
                "number": _safe(lambda: int(m.number)),
                "object": c.path_of(obj) if obj is not None else None,
                "position": to_text(_safe(lambda: m.position_text)),
            })
    return {"messages": msgs}


def _library_manager(c):
    root = c.app if c.app is not None else c.proj
    for ch in children(root):
        if kind_of(ch, c.app_guid) == "library_manager":
            return ch
    raise OpError("no_library_manager", "No Library Manager found under %s." % (name_of(root) if c.app is not None else "the project"))


def op_libraries_list(args):
    c = Ctx()
    lm = _library_manager(c)
    refs = []
    for r in list(_safe(lambda: lm.references, []) or []):
        rec = {"name": to_text(_safe(lambda: r.name))}
        for attr in ("is_placeholder", "is_managed", "namespace", "effective_resolution", "default_resolution"):
            v = _safe(lambda: getattr(r, attr))
            if v is not None:
                rec[attr] = v if isinstance(v, bool) else to_text(v)
        refs.append(rec)
    if not refs:
        refs = [{"name": to_text(n)} for n in (_safe(lambda: lm.get_libraries(False), []) or [])]
    return {"libraries": refs}


def op_library_api(args):
    """Declarations of a referenced library's objects, read from its source
    .library file opened as a secondary, read-only project. Compiled libraries
    (.compiled-library) carry no readable source."""
    c = Ctx()
    want = (args.get("name") or "").strip().lower()
    lm = _library_manager(c)
    match = None
    for r in list(_safe(lambda: lm.references, []) or []):
        nm = (to_text(_safe(lambda: r.name)) or "").strip()
        short = nm.lstrip("#").split(",")[0].strip().lower()
        if nm.lower() == want or short == want:
            match = r
            break
    if match is None:
        raise OpError("not_found", "No library reference named '%s'. Use list_libraries." % args.get("name"))
    display = to_text(_safe(lambda: match.effective_resolution)) or to_text(_safe(lambda: match.name))
    glm = getattr(se, "librarymanager", None)
    if glm is None:
        raise OpError("unavailable", "The CODESYS library manager is not available to scripts here.")
    managed = _safe(lambda: match.managed_library)
    if managed is None:
        found = _safe(lambda: glm.find_library(display))
        if found:
            managed = found[0]
    if managed is None:
        raise OpError("not_installed", "Library %s is not installed in any repository." % display)
    path = to_text(_safe(lambda: glm.get_file_path(managed))) or ""
    info = {"library": display, "path": path, "title": to_text(_safe(lambda: managed.title)),
            "version": to_text(_safe(lambda: managed.version)), "company": to_text(_safe(lambda: managed.company))}
    if not path.lower().endswith(".library"):
        info["compiled"] = True
        info["nodes"] = []
        return info
    proj = se.projects.open(path, primary=False)
    if proj is None:
        raise OpError("open_failed", "CODESYS could not open %s." % path)
    try:
        out = []
        _walk(c, proj, [], None, True, out)
        for n in out:
            n.pop("implementation", None)
        info["nodes"] = out
    finally:
        _safe(lambda: proj.close())
    return info


def op_libraries_add(args):
    c = Ctx()
    lm = _library_manager(c)
    lm.add_library(args["name"])
    return {"added": args["name"], "saved": c.save_if(args)}


def op_tasks_list(args):
    c = Ctx()
    tasks = []
    root = c.app if c.app is not None else c.proj

    def rec(obj):
        for ch in children(obj):
            k = kind_of(ch, c.app_guid)
            if k == "task":
                tasks.append({
                    "name": name_of(ch),
                    "path": c.path_of(ch),
                    "interval": to_text(_safe(lambda: ch.interval)),
                    "interval_unit": to_text(_safe(lambda: ch.interval_unit)),
                    "priority": to_text(_safe(lambda: ch.priority)),
                    "kind": to_text(_safe(lambda: ch.kind_of_task)),
                    "pous": [to_text(getattr(p, "pou_name", None) or getattr(p, "name", None) or p)
                             for p in (_safe(lambda: list(ch.pous), []) or [])],
                })
            elif k in ("task_config", "folder"):
                rec(ch)
    rec(root)
    return {"tasks": tasks}


OPS = {
    "ping": op_ping,
    "project.open": op_project_open,
    "project.create_empty": op_project_create_empty,
    "project.info": op_project_info,
    "project.save": op_project_save,
    "project.close": op_project_close,
    "tree": op_tree,
    "objects.read": op_objects_read,
    "object.write": op_object_write,
    "object.create": op_object_create,
    "object.delete": op_object_delete,
    "object.rename": op_object_rename,
    "export": op_export,
    "build": op_build,
    "libraries.list": op_libraries_list,
    "libraries.add": op_libraries_add,
    "tasks.list": op_tasks_list,
    "library.api": op_library_api,
}
