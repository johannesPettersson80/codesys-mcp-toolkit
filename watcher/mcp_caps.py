# -*- coding: utf-8 -*-
# Which optional features this CODESYS offers. Several actions rely on CODESYS's
# services beyond its documented scripting API, or on add-ons (visualization, alarm
# management). Each check reaches the service the same way its module does, so a
# feature reported available is one that action can use.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import os

import mcp_ops
from mcp_ops import _safe

import scriptengine as se


def _type(name):
    from System import AppDomain
    for a in AppDomain.CurrentDomain.GetAssemblies():
        try:
            t = a.GetType(name)
        except Exception:
            t = None
        if t is not None:
            return t
    return None


def _assembly(name):
    from System import AppDomain
    for a in AppDomain.CurrentDomain.GetAssemblies():
        if a.GetName().Name == name:
            return True
    return False


def _check(fn):
    try:
        return bool(fn())
    except Exception:
        return False


def op_capabilities(args):
    import mcp_lang
    import mcp_debug
    caps = {
        "visualization": _check(lambda: hasattr(se, "VisualElementType")),
        "signatures": _check(lambda: mcp_lang._service("LanguageModelMgr") is not None),
        "cross_references": _check(lambda: mcp_lang._service("CrossReferenceService") is not None),
        "debugging": _check(lambda: mcp_debug._bpm() is not None),
        "trace": _check(lambda: hasattr(se, "trace")),
        "alarms": _check(lambda: _assembly("AlarmConfigurationObjects.plugin")),
        "visu_users": _check(lambda: _type("_3S.CoDeSys.VisualObject.VisuUserMgmtLibraryInserter") is not None),
        "device_repository": _check(lambda: _safe(lambda: se.device_repository) is not None),
        "library_manager": _check(lambda: getattr(se, "librarymanager", None) is not None),
        "editor_window": os.environ.get("CODESYS_MCP_UI") == "1",
    }
    fpu = None
    glm = getattr(se, "librarymanager", None)
    if glm is not None:
        fpu = _check(lambda: any((l.title or "").lower() == "floatingpointutils" for l in glm.get_all_libraries()))
    caps["floating_point_utils"] = fpu
    return {"capabilities": caps}


mcp_ops.OPS["capabilities"] = op_capabilities
