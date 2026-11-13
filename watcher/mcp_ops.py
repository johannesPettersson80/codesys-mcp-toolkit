# -*- coding: utf-8 -*-
# Operation handlers for the codesys-mcp-toolkit watcher.
# Runs inside CODESYS (IronPython 2.7) and under CPython 3 with a fake
# scriptengine in tests. Keep this file ASCII-only.
from __future__ import print_function

import os
import re
import sys

import scriptengine as se

from mcp_compat import PY2, to_text


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


def _build_props(obj):
    """An object's build properties, only those that are set (they are rare)."""
    out = {}
    if _safe(lambda: obj.effectively_excluded_from_build, False):
        out["excluded"] = True
    bp = _safe(lambda: obj.build_properties)
    if bp is not None:
        if _safe(lambda: bp.link_always_is_valid, False) and _safe(lambda: bp.link_always, False):
            out["link_always"] = True
        if _safe(lambda: bp.external_is_valid, False) and _safe(lambda: bp.external, False):
            out["external"] = True
    return out


def _split_defines(text):
    """CODESYS compiler defines: 'A, B:=2; C' -> ['A', 'B', 'C']."""
    out = []
    for part in re.split(r"[,;\s]+", to_text(text) or ""):
        name = part.split(":=")[0].strip()
        if name:
            out.append(name)
    return out


def _project_info(proj, ctx=None):
    ctx = ctx or Ctx()
    info = {
        "path": to_text(_safe(lambda: proj.path)),
        "dirty": bool(_safe(lambda: proj.dirty, False)),
        "application": name_of(ctx.app) if ctx.app is not None else None,
    }
    if ctx.app is not None:
        bp = _safe(lambda: ctx.app.build_properties)
        if bp is not None and _safe(lambda: bp.compiler_defines_is_valid, False):
            info["defines"] = _split_defines(_safe(lambda: bp.compiler_defines, ""))
    settings = _safe(lambda: proj.project_settings)
    if settings is not None:
        # Scripting 4.2 and later
        cv = _safe(lambda: settings.get_compilerversion())
        if cv is None:
            cv = _safe(lambda: settings.compilerversion)
        if cv is not None:
            info["compiler_version"] = to_text(cv)
        pd = _safe(lambda: settings.project_defines)
        if pd is not None:
            info["project_defines"] = _split_defines(pd if isinstance(pd, (str, type(u""))) else ", ".join(to_text(x) for x in pd))
    return info


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
    if kind in ("pou", "gvl", "dut", "folder", "interface"):
        b = _build_props(obj)
        if b:
            node["build"] = b
    if with_text:
        if decl is not None:
            node["declaration"] = decl
        impl = impl_of(obj)
        if impl is not None:
            node["implementation"] = impl
        if st is False:
            # A graphical body has no text: keep its PLCopenXML, so checkpoints can restore it.
            xml = _export_xml(obj)
            if xml:
                node["xml"] = xml
    return node


def _export_xml(obj):
    import io
    f = os.path.join(os.environ.get("CODESYS_MCP_DIR") or os.environ.get("TEMP") or ".", "node-export.xml")
    try:
        obj.export_xml(None, f, True)
        with io.open(f, "r", encoding="utf-8-sig") as fh:
            return fh.read()
    except Exception:
        return None
    finally:
        _safe(lambda: os.remove(f))


def op_object_import_xml(args):
    """Recreate an object from PLCopenXML (export_xml) under parent, e.g. a graphical POU
    when a checkpoint is restored."""
    import io
    c = Ctx()
    parent = c.resolve(args.get("parent") or ".")
    before = set(name_of(x).lower() for x in children(parent))
    f = os.path.join(os.environ.get("CODESYS_MCP_DIR") or os.environ.get("TEMP") or ".", "import.xml")
    try:
        with io.open(f, "w", encoding="utf-8") as fh:
            fh.write(args["xml"] if not PY2 or isinstance(args["xml"], unicode) else args["xml"].decode("utf-8"))  # noqa: F821
        parent.import_xml(None, f)
    finally:
        _safe(lambda: os.remove(f))
    added = [c.path_of(x) for x in children(parent) if name_of(x).lower() not in before]
    if not added:
        raise OpError("codesys_error", "CODESYS imported nothing under %s." % (args.get("parent") or "the application"))
    return {"added": added, "saved": c.save_if(args)}


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
    if path.lower().endswith(".projectarchive"):
        # Extract next to the archive (or where asked); never over an existing project.
        target = args.get("extract_to") or (os.path.splitext(path)[0] + ".project")
        if os.path.exists(target):
            raise OpError("exists", "%s already exists. Open it directly, or pass extractTo for another file name." % target)
        proj = (se.projects.open_archive(path, target, False, None, None, None, flags) if flags is not None
                else se.projects.open_archive(path, target, False, None))
        if proj is None:
            raise OpError("open_failed", "CODESYS returned no project for archive %s" % path)
        info = _project_info(proj)
        info["extracted_from"] = path
        return info
    proj = se.projects.open(path, update_flags=flags) if flags is not None else se.projects.open(path)
    if proj is None:
        raise OpError("open_failed", "CODESYS returned no project for %s" % path)
    return _project_info(proj)


def _version_key(v):
    return [int(x) if x.isdigit() else 0 for x in to_text(v).split(".")]


def _update_device_to_newest(dev):
    """Move a device to the newest version of it in the repository. Returns that version, or None."""
    did = dev.get_device_identification()
    same = [d.device_id for d in se.device_repository.get_all_devices()
            if d.device_id.type == did.type and to_text(d.device_id.id) == to_text(did.id)]
    if not same:
        return None
    newest = max(same, key=lambda x: _version_key(x.version))
    if _version_key(newest.version) <= _version_key(did.version):
        return None
    dev.update(newest)
    return to_text(newest.version)


def op_project_open_new(args):
    """Open a project just copied from CODESYS's Standard.project and bring it up to this
    CODESYS. The shipped file can be years old: SP22's names device 3.1.3.0 and IoStandard
    3.1.3.1, which a current install doesn't have, so it can't compile. Only for such a
    fresh copy: a project the user opens is never updated (see op_project_open)."""
    path = args["path"]
    cur = se.projects.primary
    if cur is not None:
        if _safe(lambda: cur.dirty, False) and not args.get("discard_changes"):
            raise OpError("unsaved_changes", "Project %s has unsaved changes. Save it, or pass discardChanges." % to_text(cur.path))
        cur.close()
    flags = se.VersionUpdateFlags
    proj = se.projects.open(path, update_flags=flags.UpdateAll | flags.SilentMode)
    if proj is None:
        raise OpError("open_failed", "CODESYS returned no project for %s" % path)
    updated = None
    for obj in proj.get_children(False):
        if _safe(lambda: obj.is_device, False):
            updated = _update_device_to_newest(obj) or updated
    proj.save()
    # CODESYS keeps reporting the old template's load errors until the project is loaded again.
    proj.close()
    proj = se.projects.open(path, update_flags=flags.NoUpdates | flags.SilentMode)
    if proj is None:
        raise OpError("open_failed", "CODESYS returned no project for %s" % path)
    info = _project_info(proj)
    if updated:
        info["updated_device"] = updated
    return info


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
    info = _project_info(c.proj, c)
    if args.get("archive"):
        if os.path.exists(args["archive"]):
            raise OpError("exists", "%s already exists." % args["archive"])
        c.proj.save_archive(args["archive"])
        info["archive"] = args["archive"]
    return info


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
            # Empty base list: no implicit __System.IQueryInterface.
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
    steps = []
    linked = []
    was_dirty = bool(_safe(lambda: c.proj.dirty, True))
    try:
        if args.get("check_all"):
            # A build only compiles what a task reaches. Mark every other POU, GVL and
            # DUT "link always" for this build, then put the flags back.
            # (project.check_all_pool_objects() checks the POU pool, not the
            # application, and clears the build's messages.)
            for o in _walk_all(c, c.app):
                if kind_of(o, c.app_guid) not in ("pou", "gvl", "dut"):
                    continue
                if _TEST_ATTR.search(decl_of(o) or ""):
                    continue  # programs marked as tests can use assertions CODESYS doesn't know
                bp = _safe(lambda: o.build_properties)
                if bp is None or not _safe(lambda: bp.link_always_is_valid, False):
                    continue
                if _safe(lambda: bp.exclude_from_build, False) or _safe(lambda: bp.link_always, True):
                    continue
                bp.link_always = True
                linked.append(bp)
            steps.append("check_all")
        if args.get("clean"):
            c.app.clean()
            steps.append("clean")
        if args.get("deep"):
            # Code generation finds errors the build alone doesn't.
            c.app.generate_code()
            steps.append("generate_code")
        else:
            c.app.build()
            steps.append("build")
    finally:
        for bp in linked:
            _safe(lambda: setattr(bp, "link_always", False))
        if linked and not was_dirty:
            _safe(lambda: c.proj.save())  # same content as before; leaves no unsaved change behind
    msgs = []
    seen = set()
    for cat in se.system.get_message_categories(True):
        if (to_text(cat) or "").strip("{}").lower() == SCRIPT_MESSAGE_CATEGORY:
            continue
        desc = to_text(_safe(lambda: se.system.get_message_category_description(cat), ""))
        for m in se.system.get_message_objects(cat):
            obj = _safe(lambda: m.object)
            opath = c.path_of(obj) if obj is not None else None
            key = (to_text(_safe(lambda: m.text, "")), to_text(_safe(lambda: m.position_text)), opath)
            if key in seen:  # the same message from the build and the full check
                continue
            seen.add(key)
            msgs.append({
                "category": desc,
                "severity": to_text(_safe(lambda: m.severity, "")),
                "text": to_text(_safe(lambda: m.text, "")),
                "prefix": to_text(_safe(lambda: m.prefix)),
                "number": _safe(lambda: int(m.number)),
                "object": opath,
                "position": _exact_position(m),
                "length": _safe(lambda: int(m.length)),
            })
    return {"messages": msgs, "steps": steps}


def _exact_position(m):
    """position_text, with the column from position_offset: CODESYS's text says
    'Column 1' while position_offset holds where the token starts in the line
    (verified on SP21: 'Line 2, Column 1' for an error at offset 4, length 6)."""
    text = to_text(_safe(lambda: m.position_text))
    offset = _safe(lambda: int(m.position_offset))
    if text and offset is not None and offset >= 0:
        text = re.sub(r"Column \d+", "Column %d" % (offset + 1), text, count=1)
    return text


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


def _installed_libraries(name):
    """The installed libraries with this title; None when scripts can't see the repositories."""
    glm = getattr(se, "librarymanager", None)
    if glm is None:
        return None
    want = (name or "").strip().lstrip("#").split(",")[0].strip().lower()
    return [l for l in glm.get_all_libraries() if (to_text(l.title) or "").lower() == want]


def op_library_find(args):
    found = _installed_libraries(args.get("name"))
    if found is None:
        raise OpError("unavailable", "The CODESYS library manager is not available to scripts here.")
    return {
        "repositories": [to_text(r.root_folder) for r in se.librarymanager.repositories],
        "matches": [{"title": to_text(l.title), "version": to_text(l.version), "company": to_text(l.company)} for l in found],
    }


def op_libraries_add(args):
    c = Ctx()
    lm = _library_manager(c)
    name = args["name"].strip()
    if "," not in name:
        # A bare title, e.g. "Util": the newest installed, or the version asked for.
        found = _installed_libraries(name)
        if found is not None:
            if not found:
                raise OpError("not_found", "No library titled '%s' is installed in the CODESYS repositories." % name)
            newest = max(found, key=lambda l: _version_key(l.version))
            name = "%s, %s (%s)" % (to_text(newest.title), args.get("version") or "*", to_text(newest.company))
    lm.add_library(name)
    return {"added": name, "saved": c.save_if(args)}


def op_libraries_remove(args):
    c = Ctx()
    lm = _library_manager(c)
    name = args["name"]
    names = [to_text(n) for n in (_safe(lambda: list(lm.get_libraries(False)), []) or [])]
    match = [n for n in names if n.lower() == name.lower()] or [n for n in names if n.lower().split(",")[0].strip() == name.lower().split(",")[0].strip()]
    if not match:
        raise OpError("not_found", "%s is not referenced. Referenced: %s" % (name, ", ".join(names) or "none"))
    lm.remove_library(match[0])
    left = [to_text(n) for n in (_safe(lambda: list(lm.get_libraries(False)), []) or [])]
    if match[0] in left:
        raise OpError("codesys_error", "CODESYS did not remove %s." % match[0])
    return {"removed": match[0], "saved": c.save_if(args)}


def op_tasks_list(args):
    c = Ctx()
    tasks = []
    root = c.app if c.app is not None else c.proj

    def rec(obj):
        for ch in children(obj):
            k = kind_of(ch, c.app_guid)
            if k == "task":
                tasks.append(_task_info(c, ch))
            elif k in ("task_config", "folder"):
                rec(ch)
    rec(root)
    return {"tasks": tasks}


def op_objects_xml(args):
    """Objects as PLCopenXML (export_xml), e.g. graphical bodies (SFC, CFC, LD, FBD) that
    have no ST text. Read-only: the XML goes through a temp file in the session folder."""
    import io
    c = Ctx()
    tmp = os.environ.get("CODESYS_MCP_DIR") or os.environ.get("TEMP") or "."
    limit = int(args.get("max_chars") or 200000)
    res = []
    for k, p in enumerate(args.get("paths", [])):
        f = os.path.join(tmp, "export-%d.xml" % k)
        try:
            obj = c.resolve(p)
            obj.export_xml(None, f, True)
            with io.open(f, "r", encoding="utf-8-sig") as fh:
                xml = fh.read()
            res.append({"path": c.path_of(obj), "kind": kind_of(obj, c.app_guid), "xml": xml[:limit], "truncated": len(xml) > limit, "chars": len(xml)})
        except OpError as e:
            res.append({"path": p, "error": e.message, "code": e.code})
        except Exception as e:
            res.append({"path": p, "error": to_text(e), "code": "codesys_error"})
        finally:
            _safe(lambda: os.remove(f))
    return {"objects": res}


def op_devices_list(args):
    """The device tree with identification and state, and each device's I/O mapping
    as CODESYS exports it (export_io_mappings_as_csv: 'CoDeSys Mapping Export V1.2').
    Read-only: the CSV goes to a temp file in the session folder."""
    c = Ctx()
    tmp = os.environ.get("CODESYS_MCP_DIR") or os.environ.get("TEMP") or "."
    out = []

    def rec(obj, names, depth):
        for ch in children(obj):
            nm = name_of(ch)
            if _safe(lambda: ch.is_device, False):
                ident = _safe(lambda: ch.get_device_identification())
                # A module (a device that exists only inside its owner, such as Machine Expert's
                # local I/O and embedded functions) reports its owner's type and id; its module
                # id is what tells it apart.
                mod = _safe(lambda: ch.get_module_identification())
                module = to_text(_safe(lambda: mod.module_id)) if mod is not None else ""
                info = {
                    "path": "/".join(names + [nm]),
                    "name": nm,
                    "depth": depth,
                    "type": _safe(lambda: int(ident.type)),
                    "id": to_text(_safe(lambda: ident.id)),
                    "version": to_text(_safe(lambda: ident.version)),
                    "module": module or None,
                    "enabled": _safe(lambda: bool(ch.is_enabled())),
                }
                if args.get("io", True):
                    p = os.path.join(tmp, "io-mapping-%d.csv" % len(out))
                    try:
                        ch.export_io_mappings_as_csv(p)
                        with open(p) as f:
                            text = f.read()
                        if any(l.strip() and not l.startswith("//") for l in text.splitlines()):
                            info["io_csv"] = text
                    except Exception as e:
                        info["io_error"] = to_text(e)
                    finally:
                        _safe(lambda: os.remove(p))
                out.append(info)
                rec(ch, names + [nm], depth + 1)
            elif kind_of(ch, c.app_guid) in ("folder", "other"):
                rec(ch, names + [nm], depth)  # devices sit under "Plc Logic" and folders
    rec(c.proj, [], 0)
    return {"devices": out}


def _task_info(c, t):
    wd = _safe(lambda: t.watchdog)
    return {
        "name": name_of(t),
        "path": c.path_of(t),
        "interval": to_text(_safe(lambda: t.interval)),
        "interval_unit": to_text(_safe(lambda: t.interval_unit)),
        "priority": to_text(_safe(lambda: t.priority)),
        "kind": to_text(_safe(lambda: t.kind_of_task)),
        "event": to_text(_safe(lambda: t.event)) or None,
        "core_binding": _safe(lambda: int(t.core_binding)),
        "watchdog": {
            "enabled": bool(_safe(lambda: wd.enabled, False)),
            "time": to_text(_safe(lambda: wd.time)),
            "time_unit": to_text(_safe(lambda: wd.time_unit)),
            "sensitivity": to_text(_safe(lambda: wd.sensitivity)),
        } if wd is not None else None,
        "pous": [to_text(getattr(p, "pou_name", None) or getattr(p, "name", None) or p)
                 for p in (_safe(lambda: list(t.pous), []) or [])],
    }


def _find_kind(c, root, kind):
    out = []

    def rec(obj):
        for ch in children(obj):
            k = kind_of(ch, c.app_guid)
            if k == kind:
                out.append(ch)
            if k in ("task_config", "folder"):
                rec(ch)
    rec(root)
    return out


_TASK_KINDS = {"cyclic": "Cyclic", "freewheeling": "Freewheeling", "event": "Event", "external_event": "ExternalEvent", "status": "Status"}


def op_task_configure(args):
    """Create or change a task: kind, interval, priority, event, watchdog, and its program calls."""
    c = Ctx()
    if c.app is None:
        raise OpError("no_application", "The project has no active application.")
    name = args["name"]
    tasks = [t for t in _find_kind(c, c.app, "task") if name_of(t).lower() == name.lower()]
    created = False
    if tasks:
        task = tasks[0]
    elif args.get("create"):
        cfgs = _find_kind(c, c.app, "task_config")
        cfg = cfgs[0] if cfgs else c.app.create_task_configuration()
        task = cfg.create_task(name)
        created = True
    else:
        known = ", ".join(name_of(t) for t in _find_kind(c, c.app, "task")) or "none"
        raise OpError("not_found", "No task %s (tasks: %s). Pass create to make it." % (name, known))

    if args.get("kind"):
        k = _TASK_KINDS.get(args["kind"].lower())
        if k is None:
            raise OpError("bad_args", "kind must be one of %s" % ", ".join(sorted(_TASK_KINDS)))
        task.kind_of_task = getattr(se.KindOfTask, k)
    for key in ("interval", "interval_unit", "priority", "event"):
        if args.get(key) is not None:
            setattr(task, key, to_text(args[key]))
    if args.get("core_binding") is not None:
        task.core_binding = int(args["core_binding"])
    wd = args.get("watchdog")
    if wd:
        w = task.watchdog
        if wd.get("enabled") is not None:
            w.enabled = bool(wd["enabled"])
        for key in ("time", "time_unit", "sensitivity"):
            if wd.get(key) is not None:
                setattr(w, key, to_text(wd[key]))

    calls = [to_text(getattr(p, "pou_name", None) or getattr(p, "name", None) or p).lower() for p in list(task.pous)]
    for prog in args.get("remove_calls") or []:
        if prog.lower() not in calls:
            raise OpError("not_found", "Task %s doesn't call %s." % (name_of(task), prog))
        _remove_call(task, calls.index(prog.lower()), prog)
        calls.remove(prog.lower())
    if args.get("add_calls"):
        programs = dict((name_of(p).lower(), name_of(p)) for p in _walk_kind(c, c.app, "pou") if subkind("pou", decl_of(p)) == "program")
        for prog in args["add_calls"]:
            real = programs.get(prog.lower())
            if real is None:
                raise OpError("not_found", "%s is not a PROGRAM in the application; a task can only call programs." % prog)
            if real.lower() in calls:
                continue
            task.pous.add(real, "")
            calls.append(real.lower())
    info = _task_info(c, task)
    info["created"] = created
    info["saved"] = c.save_if(args)
    return info


def _remove_call(task, index, name):
    """Remove a task's program call, and check that it is gone. CODESYS V3.5 SP21's
    scripting can't do this: pous.remove(name) returns without removing anything,
    and pous.remove(index) fails with "not found in the specified Collection"
    (verified 9 November 2026). Say so instead of pretending."""
    before = [to_text(x).lower() for x in task.pous]
    for attempt in (lambda: task.pous.remove(name), lambda: task.pous.remove(index)):
        try:
            attempt()
        except Exception:
            pass
        if len([x for x in task.pous]) < len(before):
            return
    raise OpError(
        "not_supported",
        "CODESYS's scripting can't remove a program call from a task (Scripting 4.1 and 4.2, on SP21 and SP22: "
        "remove() leaves the call in place). Remove it in CODESYS: Task Configuration > %s > select %s > Remove Call. "
        "Adding calls works." % (name_of(task), name))


_TEST_ATTR = re.compile(r"\{\s*attribute\s+'test'\s*\}", re.I)


def _walk_all(c, root):
    """Every object directly in root or in its folders (not inside POUs)."""
    out = []

    def rec(obj):
        for ch in children(obj):
            if kind_of(ch, c.app_guid) == "folder":
                rec(ch)
            else:
                out.append(ch)
    rec(root)
    return out


def _walk_kind(c, root, kind):
    """Every object of a kind below root, through folders."""
    out = []

    def rec(obj):
        for ch in children(obj):
            k = kind_of(ch, c.app_guid)
            if k == kind:
                out.append(ch)
            if k == "folder":
                rec(ch)
    rec(root)
    return out


def _members(obj):
    """Public member names of a scripting object (names only; nothing is called).
    CODESYS's script objects are dynamic, so dir() can be empty: then the .NET
    type's members are listed instead."""
    if obj is None:
        return None
    names = [n for n in (_safe(lambda: dir(obj), []) or []) if not n.startswith("_")]
    if not names:
        t = _safe(lambda: obj.GetType())
        if t is not None:
            names = [to_text(m.Name) for m in (_safe(lambda: t.GetMembers(), []) or [])]
            names = ["%s" % n for n in names if n and not n.startswith("_") and not n.startswith("get_") and not n.startswith("set_") and n not in (".ctor", "GetType", "ToString", "Equals", "GetHashCode")]
            names.append("<.NET %s>" % to_text(_safe(lambda: t.FullName)))
    return sorted(set(names))


def _versionish(obj):
    """Values of non-callable members named like a version or define (to compare CODESYS versions)."""
    out = {}
    for n in _members(obj) or []:
        low = n.lower()
        if "version" not in low and "define" not in low:
            continue
        v = _safe(lambda: getattr(obj, n))
        if v is None or callable(v):
            continue
        out[n] = to_text(v)
    return out


def _reflect_api(path):
    """Every public type and member of the loaded scripting assemblies, through .NET
    reflection, in the shape of system.dump_scripting_api (which Scripting 4.2 removed)."""
    try:
        import System  # IronPython only
    except ImportError:
        return "not available (no .NET)"
    import json
    types = []
    for asm in System.AppDomain.CurrentDomain.GetAssemblies():
        aname = to_text(_safe(lambda: asm.GetName().Name, ""))
        if "script" not in aname.lower():
            continue
        exported = _safe(lambda: asm.GetExportedTypes(), []) or []
        for t in exported:
            members = []
            for m in _safe(lambda: t.GetMembers(), []) or []:
                mt = to_text(m.MemberType)
                if mt == "Method":
                    params = [{"Type": to_text(_safe(lambda: p.ParameterType.FullName) or _safe(lambda: p.ParameterType.Name))} for p in (_safe(lambda: m.GetParameters(), []) or [])]
                    rt = _safe(lambda: m.ReturnType)
                elif mt == "Property":
                    params = [{"Type": to_text(_safe(lambda: p.ParameterType.FullName) or _safe(lambda: p.ParameterType.Name))} for p in (_safe(lambda: m.GetIndexParameters(), []) or [])]
                    rt = _safe(lambda: m.PropertyType)
                else:
                    continue
                members.append({"Name": to_text(m.Name), "MemberType": mt, "Parameters": params,
                                "Type": to_text(_safe(lambda: rt.FullName) or _safe(lambda: rt.Name)) if rt is not None else None})
            types.append({"Namespace": to_text(t.Namespace), "Name": to_text(t.Name), "Assembly": aname, "Members": members})
    doc = {"MetaData": {"Generator": "reflection, %s" % to_text(sys.version).replace("\n", " ")[:120]}, "Types": types}
    text = json.dumps(doc)
    with open(path, "w") as f:
        f.write(text.encode("utf-8") if PY2 and isinstance(text, unicode) else text)  # noqa: F821
    return "%d types" % len(types)


def op_api_probe(args):
    """The scripting API this CODESYS offers: member names of the main objects, the
    enums the watcher relies on, version-like values, and the object type GUIDs of
    the open project with their kinds. For comparing service packs (docs/sp22-plan.md)."""
    c = Ctx(require_project=False)
    objs = {"se": se, "system": _safe(lambda: se.system), "projects": _safe(lambda: se.projects), "project": c.proj, "application": c.app}
    samples = {}
    types = {}
    if c.proj is not None:
        stack = [c.proj]
        while stack and len(types) < 200:
            o = stack.pop()
            t = (to_text(_safe(lambda: o.type)) or "").strip("{}").lower()
            k = kind_of(o, c.app_guid)
            if t and t not in types:
                types[t] = {"kind": k, "example": name_of(o)}
            if k in ("pou", "method", "property", "accessor", "action", "dut", "gvl", "interface", "folder") and k not in samples:
                samples[k] = o
            stack.extend(_safe(lambda: children(o), []) or [])
    for k, o in samples.items():
        objs["obj_" + k] = o
    pou = samples.get("pou")
    if pou is not None:
        objs["textual_declaration"] = _safe(lambda: pou.textual_declaration)
        objs["textual_implementation"] = _safe(lambda: pou.textual_implementation)
    enums = {}
    for n in ("VersionUpdateFlags", "PouType", "DutType", "ScriptPromptHandling", "PromptHandling", "ImplementationLanguages", "ProjectProperties"):
        e = _safe(lambda: getattr(se, n))
        enums[n] = _members(e) if e is not None else None
    reflected = None
    if args.get("reflect_path"):
        reflected = _reflect_api(args["reflect_path"])
    dump = None
    if args.get("dump_path"):
        # CODESYS's own description of its scripting API (system.dump_scripting_api).
        fn = _safe(lambda: se.system.dump_scripting_api)
        if fn is None:
            dump = "not available"
        else:
            try:
                r = fn(args["dump_path"])
                dump = "written" if os.path.exists(args["dump_path"]) else ("returned: %s" % to_text(r)[:200])
            except Exception as e:
                try:
                    r = fn()
                    text = to_text(r) or ""
                    if text:
                        with open(args["dump_path"], "w") as f:
                            f.write(text.encode("utf-8") if PY2 else text)
                    dump = "returned %d chars (no-argument form; with a path: %s)" % (len(text), to_text(e))
                except Exception as e2:
                    dump = "failed: %s / %s" % (to_text(e), to_text(e2))
    return {
        "python": to_text(_safe(lambda: sys.version, "")).replace("\n", " ")[:120],
        "dump": dump,
        "reflected": reflected,
        "members": dict((k, _members(v)) for k, v in objs.items()),
        "versions": dict((k, _versionish(v)) for k, v in objs.items() if v is not None),
        "enums": enums,
        "types": types,
        "unknown_types": sorted(t for t, v in types.items() if v["kind"] == "other"),
    }


OPS = {
    "api.probe": op_api_probe,
    "ping": op_ping,
    "project.open": op_project_open,
    "project.open_new": op_project_open_new,
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
    "libraries.remove": op_libraries_remove,
    "tasks.list": op_tasks_list,
    "task.configure": op_task_configure,
    "devices.list": op_devices_list,
    "objects.xml": op_objects_xml,
    "object.import_xml": op_object_import_xml,
    "library.api": op_library_api,
    "library.find": op_library_find,
}
