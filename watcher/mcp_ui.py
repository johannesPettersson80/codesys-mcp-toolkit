# -*- coding: utf-8 -*-
# --show-window extras: open the object a request just wrote in a CODESYS editor tab, so
# the user sees the code arrive in the window instead of only the project tree.
#
# CODESYS's scripting API has no call for this. It uses CODESYS's own (undocumented) .NET
# frame instead: IFrame.OpenEditorView, the call behind "Edit Object". Checked on CODESYS
# V3.5 SP21 and SP22. Best-effort: a failure is only logged and never changes a result.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).

_CACHE = {}

# Any plugin's APEnvironment exposes the engine (with its frame) and the object manager.
_ENV_TYPES = ("_3S.CoDeSys.SecurityManager.APEnvironment", "_3S.CoDeSys.VisualEditor.APEnvironment")


def _find_env():
    from System import AppDomain
    asms = list(AppDomain.CurrentDomain.GetAssemblies())
    for name in _ENV_TYPES:
        for asm in asms:
            try:
                t = asm.GetType(name)
            except Exception:
                t = None
            if t is not None:
                return t
    return None


def _env():
    if "env" not in _CACHE:
        try:
            _CACHE["env"] = _find_env()
        except Exception:
            _CACHE["env"] = None
    return _CACHE["env"]


def open_editor(se, obj):
    """Opens obj in its editor in the CODESYS window (or brings its tab forward).

    Returns "opened", "fake" (the test engine) or "unavailable" (no frame found)."""
    if hasattr(se, "FAKE"):
        return "fake"
    env = _env()
    if env is None:
        return "unavailable"
    from System import Guid
    engine = env.GetProperty("Engine").GetValue(None, None)
    objects = env.GetProperty("ObjectMgr").GetValue(None, None)
    stub = objects.GetMetaObjectStub(se.projects.primary.handle, obj.guid)
    engine.Frame.OpenEditorView(stub, Guid.Empty, None)
    return "opened"
