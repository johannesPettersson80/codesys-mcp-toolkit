# -*- coding: utf-8 -*-
# What CODESYS's compiler knows about the code: the interface of any POU or type
# (including FBs from compiled libraries, which the scripting API can't read),
# and cross-references (where a name is read, written or called).
#
# Both use CODESYS's own services, reached through a plugin's APEnvironment:
# LanguageModelMgr.FindSignaturesByName and CrossReferenceService. They work on the
# compiled language model, so the application is built first when nothing is found.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import mcp_ops
from mcp_ops import Ctx, OpError
from mcp_compat import to_text

_ENVS = ("_3S.CoDeSys.RecipeManObject.APEnvironment", "_3S.CoDeSys.VisualEditor.APEnvironment", "_3S.CoDeSys.SecurityManager.APEnvironment")
_CACHE = {}


def _find_type(name):
    if name in _CACHE:
        return _CACHE[name]
    try:
        from System import AppDomain
    except ImportError:
        raise OpError("unavailable", "CODESYS's language services need CODESYS (not available in this engine).")
    found = None
    for asm in AppDomain.CurrentDomain.GetAssemblies():
        try:
            found = asm.GetType(name)
        except Exception:
            found = None
        if found is not None:
            break
    _CACHE[name] = found
    return found


def _service(prop):
    try:
        from System.Reflection import BindingFlags
    except ImportError:
        raise OpError("unavailable", "CODESYS's language services need CODESYS (not available in this engine).")
    for tname in _ENVS:
        t = _find_type(tname)
        if t is None:
            continue
        p = t.GetProperty(prop, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
        if p is not None:
            v = p.GetValue(None, None)
            if v is not None:
                return v
    raise OpError("unavailable", "This CODESYS doesn't offer %s to scripts." % prop)


def _get(o, name, default=None):
    try:
        return getattr(o, name)
    except Exception:
        try:
            t = o.GetType()
            for it in [t] + list(t.GetInterfaces()):
                p = it.GetProperty(name)
                if p is not None:
                    return p.GetValue(o, None)
        except Exception:
            pass
    return default


def _caller(c):
    """A POU of the application to resolve names from (its scope sees the libraries)."""
    for ch in c.app.get_children(True):
        try:
            if ch.has_textual_declaration and "PROGRAM" in to_text(ch.textual_declaration.text).upper()[:200]:
                return ch
        except Exception:
            pass
    return c.app


def _clean(s):
    s = to_text(s or "").strip()
    return " ".join(s.split()) if s else ""


def _var(v, section):
    attrs = [to_text(a) for a in (_get(v, "Attributes") or [])]
    out = {"name": to_text(_get(v, "OrgName") or _get(v, "Name")), "type": to_text(_get(v, "Type")), "section": section}
    comment = _clean(_get(v, "Comment")).lstrip("| ").strip()
    if comment:
        out["comment"] = comment
    if "hide" in attrs:
        out["hidden"] = True
    init = _get(v, "Initial")
    if init is not None:
        out["init"] = to_text(init)
    return out


def _signature(lmm, c, sig):
    ins = set(to_text(_get(v, "OrgName")) for v in (_get(sig, "Inputs") or []))
    outs = set(to_text(_get(v, "OrgName")) for v in (_get(sig, "Outputs") or []))
    variables = []
    for v in lmm.GetAllVariables(sig, c.app.guid):
        n = to_text(_get(v, "OrgName"))
        variables.append(_var(v, "input" if n in ins else "output" if n in outs else "other"))
    subs = []
    try:
        for s in sig.GetSubSignatures() or []:
            subs.append(to_text(_get(s, "OrgName") or _get(s, "Name")))
    except Exception:
        pass
    return {
        "name": to_text(_get(sig, "OrgName") or _get(sig, "Name")),
        "kind": to_text(_get(sig, "POUType")),
        "library": to_text(_get(sig, "LibraryPath") or ""),
        "comment": _clean(_get(sig, "Comment")),
        "variables": variables,
        "members": subs,
    }


def op_lang_signature(args):
    c = Ctx()
    lmm = _service("LanguageModelMgr")
    caller = _caller(c)
    built = False
    out = []
    for name in args["names"]:
        sigs = lmm.FindSignaturesByName(c.proj.handle, c.app.guid, caller.guid, name)
        if (sigs is None or len(sigs) == 0) and not built:
            c.app.build()
            built = True
            sigs = lmm.FindSignaturesByName(c.proj.handle, c.app.guid, caller.guid, name)
        if sigs is None or len(sigs) == 0:
            out.append({"name": name, "error": "not found (check the spelling, and that the library is referenced)"})
            continue
        out.append(_signature(lmm, c, sigs[0]))
    return {"signatures": out, "built": built}


def op_lang_xref(args):
    import System
    from System import Guid
    c = Ctx()
    xs = _service("CrossReferenceService")
    T = _find_type("_3S.CoDeSys.LanguageModelUtilities.CrossRefSearchType")
    O = _find_type("_3S.CoDeSys.LanguageModelUtilities.CrossRefOccurence")
    M = _find_type("_3S.CoDeSys.LanguageModelUtilities.CrossReferenceMatchType")
    if T is None or O is None or M is None:
        raise OpError("unavailable", "This CODESYS doesn't offer cross-references to scripts.")
    if args.get("build", True):
        c.app.build()
    kind = {"variable": "Variables", "pou": "POUs", "type": "Types"}.get(args.get("kind") or "variable", "Variables")
    try:
        st = System.Enum.Parse(T, kind)
    except Exception:
        st = System.Enum.Parse(T, "Variables")
    nodes = xs.GetCrossReferenceNodesWithinApplication(args["name"], "", Guid.Empty, st, System.Enum.Parse(O, "LanguageModel"), System.Enum.Parse(M, "Existing"), c.app.guid)
    refs = []
    for nd in nodes or []:
        pos = _get(nd, "Position", 0) or 0
        try:
            pos = int(pos)
        except Exception:
            pos = 0
        refs.append({
            "access": to_text(_get(nd, "AccessText") or ""),
            "pou": to_text(_get(nd, "POUName") or ""),
            "location": to_text(_get(nd, "Location") or ""),
            "text": _clean(_get(nd, "Text")),
        })
    return {"name": args["name"], "references": refs}


mcp_ops.OPS.update({
    "lang.signature": op_lang_signature,
    "lang.xref": op_lang_xref,
})
