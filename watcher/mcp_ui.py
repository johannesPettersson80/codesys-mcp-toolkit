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


# The editor zoom each visualization had when it was last set offline: an online view draws
# the page at the zoom its editor had when the simulation went online.
_DESIGN_ZOOM = {}


def fit_visualization(se, size, key):
    """Zooms the visualization editor in front so the whole page (size: its width, height)
    fits its pane. At 100 % a page is wider than the editor pane of a normal window, and the
    user (or a recording) sees only a corner of it.

    Offline it sets the editor's own zoom (VisualEditor.ZoomFactor, the zoom box under the
    page). Online (the simulation runs) the page is drawn by a WebView2 inside the editor, at
    the editor zoom of the moment it went online; changing that zoom, reloading or reopening
    the view don't change it (checked on SP21), but the WebView2's own zoom scales on top of
    it. key names the visualization. Returns the zoom shown, or None without a visualization
    editor in front."""
    if hasattr(se, "FAKE"):
        return None
    env = _env()
    if env is None:
        return None
    view = env.GetProperty("Engine").GetValue(None, None).Frame.ActiveView
    ve = getattr(view, "VisualEditor", None)
    if ve is None:
        return None
    current = getattr(view, "CurrentControl", None)
    online = current is not None and "WebView2" in current.GetType().Name
    area = current if online else ve
    w, h = size
    pane = None
    for _ in range(10):
        pane = area.ClientSize
        if pane.Width > 50 and pane.Height > 50:
            break
        se.system.delay(100)
    if pane is None or w <= 0 or h <= 0:
        return None
    # A margin for the scroll bars; at most 200 %.
    zoom = max(0.1, min(2.0, (pane.Width - 24) / float(w), (pane.Height - 24) / float(h)))
    if online:
        base = _DESIGN_ZOOM.get(key) or float(ve.ZoomFactor) or 1.0
        current.ZoomFactor = zoom / base
    else:
        ve.ZoomFactor = zoom
        _DESIGN_ZOOM[key] = zoom
    return zoom
