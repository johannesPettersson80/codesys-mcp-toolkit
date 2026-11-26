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


def quiet_cfc_routing_advice():
    """Turns off the CFC editor's "routing mode will be switched into Advanced Routing Mode"
    message. CODESYS shows it, modal, the first time a CFC editor changes a chart in a project
    (routing the lines of an imported chart is enough), and a modal dialog stops scripts until
    someone clicks OK. It is the editor's user project option AdviseAdvancedRouting (internal
    _3S.CoDeSys.CFCEditor.OptionsHelper, checked on SP21). Best-effort; returns whether it was set."""
    ok = False
    try:
        from System import AppDomain
        from System.Reflection import BindingFlags
        flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        for asm in AppDomain.CurrentDomain.GetAssemblies():
            t = asm.GetType("_3S.CoDeSys.CFCEditor.OptionsHelper")
            if t is None:
                continue
            prop = t.GetProperty("AdviseAdvancedRouting", flags)
            if prop is not None:
                prop.SetValue(None, False, None)
                ok = True
            break
    except Exception:
        ok = False
    # The option belongs to the project: set it again for the next project.
    return ok


def open_editor(se, obj):
    """Opens obj in its editor in the CODESYS window (or brings its tab forward).

    Returns "opened", "fake" (the test engine) or "unavailable" (no frame found)."""
    if hasattr(se, "FAKE"):
        return "fake"
    env = _env()
    if env is None:
        return "unavailable"
    quiet_cfc_routing_advice()
    from System import Guid
    engine = env.GetProperty("Engine").GetValue(None, None)
    objects = env.GetProperty("ObjectMgr").GetValue(None, None)
    stub = objects.GetMetaObjectStub(se.projects.primary.handle, obj.guid)
    engine.Frame.OpenEditorView(stub, Guid.Empty, None)
    return "opened"


def _give_room(se, control):
    """Makes room for a visualization page before it is fitted: maximizes the CODESYS window
    (a page is 1280 px or more wide; a window of normal size leaves the editor a narrow
    column between the docked panes) and folds away the Interface Editor that the
    visualization editor shows above the page (its VAR_IN_OUT, empty for a page). The
    editor is a WinForms SplitContainer with the Interface Editor's tabs in Panel1 (checked
    with UI Automation on SP21). Best-effort: anything not found is left as it is."""
    try:
        form = control.FindForm()
        if form is not None and form.TopLevel:
            from System.Windows.Forms import FormWindowState
            if form.WindowState != FormWindowState.Maximized:
                form.WindowState = FormWindowState.Maximized
    except Exception:
        pass
    try:
        from System import Object
        from System.Windows.Forms import SplitContainer
        node, inner = control, None
        for _ in range(12):
            if node is None:
                break
            if isinstance(node, SplitContainer) and inner is not None and Object.ReferenceEquals(node.Panel2, inner) and not node.Panel1Collapsed:
                node.Panel1Collapsed = True
                break
            inner, node = node, node.Parent
    except Exception:
        pass
    se.system.delay(300)  # let the window lay itself out again before the pane is measured


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
    _give_room(se, area)
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


def close_visualizations(se):
    """Closes the visualization editors in the CODESYS window; returns how many. Called before
    the simulation goes offline: after a visualization editor showed a page online, the next
    build fails with "Sending service failed, status: 404" until the project is opened again."""
    if hasattr(se, "FAKE"):
        return 0
    env = _env()
    if env is None:
        return 0
    frame = env.GetProperty("Engine").GetValue(None, None).Frame
    n = 0
    for v in list(frame.GetEditorViews()):
        if getattr(v, "VisualEditor", None) is not None:
            frame.CloseView(v)
            n += 1
    return n
