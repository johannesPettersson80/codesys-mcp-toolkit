# -*- coding: utf-8 -*-
# Native CODESYS visualizations, built from a plan the server computes (src/hmi/native.ts).
#
# Two routes, both CODESYS's own:
# - the visualization script driver (create_visualobject, add_element, set_property with
#   property-view paths) for image switchers, bindings, colour toggles, movement, inputs;
# - CODESYS's element creators (the objects its toolbox uses) for what the property paths
#   can't set: a static font, a gradient, a hidden frame or fill. Added through CODESYS's
#   object manager, like the toolbox does.
# A page's elements are created in one transaction with their bindings (_create_all): one
# transaction per element made a page take minutes.
# Rounded corners (radius type and value), the text format, the canvas background and an image
# switcher's position are members of CODESYS's element objects that were checked alone (read back
# through the script driver, the build compiled). Nothing here writes other raw members (some
# raise assertion dialogs).
# A property that fails is reported, not fatal. render paints a visualization into a PNG.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import os

import mcp_ops
from mcp_ops import Ctx, OpError, name_of
from mcp_compat import to_text

import scriptengine as se

_CACHE = {}


def _find_type(name):
    if ("t", name) in _CACHE:
        return _CACHE[("t", name)]
    from System import AppDomain
    found = None
    for asm in AppDomain.CurrentDomain.GetAssemblies():
        try:
            found = asm.GetType(name)
        except Exception:
            found = None
        if found is not None:
            break
    _CACHE[("t", name)] = found
    return found


def _static(type_name, prop):
    from System.Reflection import BindingFlags
    t = _find_type(type_name)
    if t is None:
        return None
    p = t.GetProperty(prop, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
    return p.GetValue(None, None) if p is not None else None


def _object_mgr():
    for t in ("_3S.CoDeSys.VisualEditor.APEnvironment", "_3S.CoDeSys.SecurityManager.APEnvironment"):
        m = _static(t, "ObjectMgr")
        if m is not None:
            return m
    raise OpError("unavailable", "CODESYS's object manager isn't reachable.")


def _drawing():
    import clr
    clr.AddReference("System.Drawing")
    import System.Drawing as SD
    return SD


def _argb(v):
    import System
    v = int(v)
    return _drawing().Color.FromArgb(System.Int32(v - 0x100000000 if v >= 0x80000000 else v))


def _value(v):
    if isinstance(v, dict) and "argb" in v:
        return _argb(v["argb"])
    return v


def _enum(type_name, wanted):
    import System
    t = _find_type(type_name)
    if t is None:
        raise OpError("unavailable", "%s not found" % type_name)
    names = list(System.Enum.GetNames(t))
    for n in names:
        if n == wanted:
            return System.Enum.Parse(t, n)
    for n in names:
        if wanted in n:
            return System.Enum.Parse(t, n)
    raise OpError("bad_args", "%s has no %s (%s)" % (type_name, wanted, ", ".join(names)))


def _pset(o, name, value):
    """Set a property, also one implemented explicitly on an interface."""
    t = o.GetType()
    for it in [t] + list(t.GetInterfaces()):
        p = it.GetProperty(name)
        if p is not None and p.CanWrite:
            p.SetValue(o, value, None)
            return
    raise AttributeError(name)


class _Modify(object):
    def __init__(self, proj, obj):
        self.h, self.g = proj.handle, obj.guid

    def __enter__(self):
        self.mgr = _object_mgr()
        self.mo = self.mgr.GetObjectToModify(self.h, self.g)
        return self.mo.Object

    def __exit__(self, et, ev, tb):
        self.mgr.SetObject(self.mo, et is None, None)
        return False


def _creator(kind):
    import System
    from System.Reflection import BindingFlags
    t = _find_type("_3S.CoDeSys.ScriptDriverVisualization.APEnvironment")
    if t is None:
        raise OpError("unavailable", "The visualization script driver isn't loaded.")
    f = t.GetMethod("CreateVisualElemCreatorFactory", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).Invoke(None, None)
    return f.CreateInstance(kind)


def _gradient(c1, c2, angle):
    import System
    GV = _find_type("_3S.CoDeSys.PropertyView.GradientView")
    k = [k for k in GV.GetConstructors() if len(k.GetParameters()) == 9][0]
    ps = k.GetParameters()
    con_t = ps[0].ParameterType

    def con(v):
        return System.Activator.CreateInstance(con_t, System.Array[object]([_argb(v)]))
    look = System.Enum.GetValues(ps[4].ParameterType).GetValue(0)
    SD = _drawing()
    return k.Invoke(System.Array[object]([con(c1), con(c2), int(angle), SD.Point(0, 0), look, 1, 0, con(c2), None]))


def _font(spec):
    SD = _drawing()
    name, size = spec[0], float(spec[1])
    style = SD.FontStyle.Bold if len(spec) > 2 and spec[2] == "bold" else SD.FontStyle.Regular
    return SD.Font(name, size, style)


_SIMPLE = {"rect": "RECTANGLE", "round": "ROUNDRECT", "circle": "CIRCLE"}


def _simple_creator(el):
    import System
    SD = _drawing()
    cr = _creator("VisuFbElemSimple")
    _pset(cr, "Type", _enum("_3S.CoDeSys.VisualElem.VisuEnumSimpleType", _SIMPLE[el["kind"]]))
    _pset(cr, "Position", SD.Rectangle(int(el["x"]), int(el["y"]), int(el["w"]), int(el["h"])))
    if el.get("text") is not None:
        _pset(cr, "Text", el["text"])
        _pset(cr, "HorizontalAlignment", _enum("_3S.CoDeSys.VisualElem.VisuEnumHorizontalAlignment", el.get("align") or "HCENTER"))
        if el.get("valign"):
            _pset(cr, "VerticalAlignment", _enum("_3S.CoDeSys.VisualElem.VisuEnumVerticalAlignment", el["valign"]))
        if el.get("font"):
            m = cr.GetType().GetInterface("ITextElementCreator").GetMethod("SetFont")
            m.Invoke(cr, System.Array[object]([_font(el["font"]), _argb(el.get("color", 0xFF0F172A))]))
    if el.get("fill") is None:
        try:
            _pset(cr, "FillAttributes", _enum("_3S.CoDeSys.VisualElem.VisuEnumBrushStyle", "NULL"))
        except OpError:
            _pset(cr, "FillAttributes", _enum("_3S.CoDeSys.VisualElem.VisuEnumBrushStyle", "HOLLOW"))
    else:
        _pset(cr, "Color", _argb(el["fill"]))
    if el.get("frame") is None:
        _pset(cr, "FrameAttributes", _enum("_3S.CoDeSys.VisualElem.VisuEnumPenStyle", "HOLLOW"))
    else:
        _pset(cr, "FrameColor", _argb(el["frame"]))
        _pset(cr, "LineWidth", int(el.get("lineWidth") or 1))
    if el.get("gradient"):
        g = el["gradient"]
        _pset(cr, "Gradient", _gradient(g[0], g[1], g[2] if len(g) > 2 else 90))
        _pset(cr, "UseGradient", True)
    if el.get("invisible"):
        _pset(cr, "InvisibleExpression", el["invisible"])
    return cr


def _localized_path(e, path):
    """The property path as this CODESYS's language names it. set_property takes the labels
    of the property view; most also resolve in English whatever the language, but not the
    input configuration (Tap, Toggle) in a German CODESYS. The tree's node ids are the same
    in every language: walk them (an id is the English segment, or it with a type prefix
    such as pVariable or bTapFalse) and return the node's own, translated, path. Some group
    ids are translated as well (Input configuration is 'Eingabekonfiguration' in German, its
    Tap and Toggle are not): such a group is found by the child the path names next."""
    try:
        node = e.ReadOnlyElement.GetPropertyRootNode()
    except Exception:
        return None

    def match(n, seg):
        key = seg.replace(" ", "").lower()
        for i in range(n.ChildCount):
            ch = n.GetChild(i)
            nid = to_text(ch.Id).replace(" ", "").lower()
            if nid == key or nid[1:] == key or nid.split(".")[-1] == key:
                return ch
        return None

    segs = path.split(".")
    for k, seg in enumerate(segs):
        found = match(node, seg)
        if found is None and k + 1 < len(segs):
            for i in range(node.ChildCount):
                ch = node.GetChild(i)
                if match(ch, segs[k + 1]) is not None:
                    found = ch
                    break
        if found is None:
            return None
        node = found
    return to_text(node.Path)


def _set_prop(e, path, value):
    """set_property with the English path, or the translated one when CODESYS runs in another language."""
    try:
        e.set_property(path, value)
    except Exception:
        local = _localized_path(e, path)
        if not local or local == path:
            raise
        e.set_property(local, value)


def _script_element(visu, eid):
    for e in visu.visual_element_list:
        if e.id == eid:
            return e
    return None


def _editor_context(c, visu, cache):
    """The open visual editor's element context for this visualization (needs CODESYS's window)."""
    if "ctx" in cache:
        return cache["ctx"]
    import os
    if os.environ.get("CODESYS_MCP_UI") != "1":
        raise OpError("unavailable", "needs CODESYS's window (start with --show-window)")
    from System.Reflection import BindingFlags
    from System import Guid
    allf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
    eng = _static("_3S.CoDeSys.VisualEditor.APEnvironment", "Engine")
    frame = getattr(eng, "Frame", None) if eng is not None else None
    if frame is None:
        raise OpError("unavailable", "needs CODESYS's window (start with --show-window)")
    view = frame.OpenEditorView(_object_mgr().GetMetaObjectStub(c.proj.handle, visu.guid), Guid.Empty, None)
    se.system.delay(800)
    ctl = view.Control
    ve = ctl.GetType().GetField("_visualEditor", allf).GetValue(ctl)
    ctx = ve.GetType().GetField("_editorCtx", allf).GetValue(ve)
    vom = _find_type("_3S.CoDeSys.VisualEditor.VisualObjectManager").GetProperty("Singleton", allf).GetValue(None, None)
    cache["ctx"] = (ctx, vom)
    return cache["ctx"]


def _complex_element(c, visu, el, label, cache):
    ctx, vom = _editor_context(c, visu, cache)
    mgr = _object_mgr()
    mo = mgr.GetObjectToModify(c.proj.handle, visu.guid)
    ok = False
    try:
        vo = mo.Object
        nid = vo.UniqueId
        elem = vom.CreateElementByTypeName(el["type_name"], None, label, nid, ctx, True, ctx.AvailableHotkeysProvider, ctx.HotkeysConfiguration)
        elem.Id = nid
        elem.OwningObjectGuid = vo.MetaObject.ObjectGuid
        vo.VisualElemList.Add(elem)
        ok = True
    finally:
        mgr.SetObject(mo, ok, None)
    e = _script_element(visu, nid)
    for p, v in (("Position.X", el["x"]), ("Position.Y", el["y"]), ("Position.Width", el["w"]), ("Position.Height", el["h"])):
        e.set_property(p, int(v))
    return e


_POS = (("m_StaticPosition.iX", "x"), ("m_StaticPosition.iY", "y"), ("m_StaticPosition.iWidth", "w"), ("m_StaticPosition.iHeight", "h"))


# Properties CODESYS's element creators take when they create an element (set_property path ->
# creator property), so they cost no extra transaction.
_AT_CREATION = {
    "Text variables.Text variable": "TextVariableExpression",
    "Color variables.Toggle color": "ToggleColorExpression",
    "Colors.Alarm state.Fill color": "ColorAlarm",
    "Colors.Alarm state.Frame color": "FrameColorAlarm",
    "Relative movement.Movement top-left.X": "RelativeMovementTopLeftX",
    "Relative movement.Movement top-left.Y": "RelativeMovementTopLeftY",
    "Relative movement.Movement bottom-right.X": "RelativeMovementBottomRightX",
    "Relative movement.Movement bottom-right.Y": "RelativeMovementBottomRightY",
    "State variables.Invisible": "InvisibleExpression",
    "Static ID": "BitmapID",
    "Bitmap ID variable.Bitmap ID": "BitmapIDExpression",
}


def _with_creator(cr, el):
    """Set what the creator can take; returns the properties it took."""
    done = []
    props = dict(el.get("props") or {})
    if el["kind"] not in _SIMPLE and el.get("invisible"):
        props["State variables.Invisible"] = el["invisible"]
    for path, v in props.items():
        name = _AT_CREATION.get(path)
        if name is None:
            continue
        try:
            _pset(cr, name, _value(v))
            done.append(path)
        except Exception:
            pass  # left to set_property
    return tuple(done)


def _create_all(c, visu, elements, warnings, base=0):
    """Every element of the plan in one transaction, in the plan's order. Adding them one by one
    made a page take minutes: CODESYS commits the whole visualization each time, so the build grew
    with the square of its size (256 elements: 377 s). Shapes and pictures come from CODESYS's
    element creators, with their bindings (_AT_CREATION). Image switchers have no creator: they are
    copies of one the script driver made, each with its own identification and name (copies sharing
    them fail the build: 'non unique ids', 'already has the name'), placed through the plain members
    iX..iHeight. What a creator can't take still goes through set_property afterwards. base:
    the page's index of the first element (unnamed elements are called E<index>).
    Returns {index in elements: (id, properties already set)}."""
    import System
    T = se.VisualElementType
    templates = {}
    if any(e["kind"] == "switcher" for e in elements):
        t = visu.visual_element_list.add_element(T.ImageSwitcher)
        templates["switcher"] = (t.id, t.ReadOnlyElement)
    SD = _drawing()
    made = {}
    try:
        with _Modify(c.proj, visu) as vo:
            lst = vo.VisualElemList
            for i, el in enumerate(elements):
                label = el.get("name") or "E%d" % (base + i)
                try:
                    done = ()
                    if el["kind"] in _SIMPLE:
                        cr = _simple_creator(el)
                        done = _with_creator(cr, el)
                        elem = cr.CreateVisualElement(label)
                    elif el["kind"] == "image":
                        cr = _creator("VisuFbElemImage")
                        _pset(cr, "Position", SD.Rectangle(int(el["x"]), int(el["y"]), int(el["w"]), int(el["h"])))
                        done = _with_creator(cr, el)
                        elem = cr.CreateVisualElement(label)
                    else:
                        elem = templates[el["kind"]][1].Clone()
                        _pset(elem, "Identification", System.Guid.NewGuid())
                        _pset(elem, "InstanceName", label)  # names are unique per visualization
                        for member, k in _POS:
                            elem.GetVisualElemMember(member, True, int(el[k])).Value = int(el[k])
                    elem.Id = vo.UniqueId
                    elem.OwningObjectGuid = vo.MetaObject.ObjectGuid
                    lst.Add(elem)
                    made[i] = (elem.Id, done)
                except Exception as ex:
                    warnings.append("%s: not added: %s" % (label, to_text(ex)))
    finally:
        for tid, _ in templates.values():
            try:
                visu.visual_element_list.remove_id(tid)
            except Exception:
                pass
    return made


def _find_child(c, name):
    for ch in c.app.get_children(False):
        if name_of(ch).lower() == name.lower():
            return ch
    return None


def op_visu_build(args):
    c = Ctx()
    if not hasattr(c.app, "create_visualobject"):
        raise OpError("unavailable", "This CODESYS has no visualization scripting (CODESYS Visualization 4.7 or later is needed).")
    name = args["name"]
    for n in (name, args.get("image_pool")):
        if not n:
            continue
        old = _find_child(c, n)
        if old is not None:
            if not args.get("replace"):
                raise OpError("exists", "%s already exists. Pass replace to rebuild it." % n)
            old.remove()
    warnings = []
    if args.get("images"):
        pool = c.app.create_imagepool(args["image_pool"])
        for img in args["images"]:
            try:
                pool.images.add(img["id"], img["path"], se.ImageLinkType.Embedded, se.AutoUpdateMode.Never)
            except Exception as ex:
                warnings.append("image %s: %s" % (img["id"], to_text(ex)))
    visu = c.app.create_visualobject(name)
    if args.get("size") or args.get("dialog"):
        try:
            _visual_property(c, visu, args.get("size"), bool(args.get("dialog")))
        except Exception as ex:
            warnings.append("size/dialog: %s" % to_text(ex))
    corners = []
    wrapped = []
    access = []
    queue = list(args.get("elements") or [])
    editor = {}
    # The plain elements in as few transactions as possible: each run of them between editor
    # elements (meters, alarm tables) in one, so the page keeps its order. Editor elements need
    # the visual editor and a transaction of their own, and may fall back to plain elements.
    # (Before, one editor element put every element of the page in a transaction of its own.)
    i = -1
    while queue:
        if queue[0]["kind"] == "complex":
            el = queue.pop(0)
            i += 1
            label = el.get("name") or "E%d" % i
            # Meters, bar displays and alarm tables need the visual editor's context, which only
            # exists with CODESYS's window. Without it, the plan's fallback elements are drawn.
            try:
                e = _complex_element(c, visu, el, label, editor)
            except Exception as ex:
                warnings.append("%s: drawn without %s (%s)" % (label, el.get("type_name"), to_text(ex)[:160]))
                queue = list(el.get("fallback") or []) + queue
                continue
            for pair in el.get("pairs") or []:
                try:
                    _set_prop(e, pair[0], _value(pair[1]))
                except Exception as ex:
                    warnings.append("%s %s: %s" % (label, pair[0], to_text(ex)[:120]))
            if el.get("access"):
                access.append((e.id, el["access"]))
            continue
        run = []
        while queue and queue[0]["kind"] != "complex":
            run.append(queue.pop(0))
        made = _create_all(c, visu, run, warnings, i + 1)
        by_id = dict((x.id, x) for x in visu.visual_element_list)
        for k, el in enumerate(run):
            i += 1
            if k not in made:
                continue  # reported by _create_all
            eid, done = made[k]
            _finish(visu, el, by_id[eid], eid, done, el.get("name") or "E%d" % i, warnings, access, wrapped, corners)
    _finish_page(c, visu, args, access, wrapped, corners, warnings)
    return {"name": name_of(visu), "path": name_of(visu), "kind": "visualization", "elements": len(visu.visual_element_list), "warnings": warnings, "saved": c.save_if(args)}


def _finish(visu, el, e, eid, done, label, warnings, access, wrapped, corners):
    """An element's properties and input actions after it was created, and what the page's
    last transaction sets for it (access rights, line break, corner radius)."""
    if el.get("access"):
        access.append((eid, el["access"]))
    props = [(p, v) for p, v in (el.get("props") or {}).items() if p not in done]
    if el.get("linebreak"):
        wrapped.append(eid)
    if el["kind"] not in _SIMPLE and el.get("invisible") and "State variables.Invisible" not in done:
        # Shapes take it when created; pictures through their state variables.
        props.append(("State variables.Invisible", el["invisible"]))
    for path, v in props:
        try:
            _set_prop(e, path, _value(v))
        except Exception as ex:
            if len(warnings) < 40:
                warnings.append("%s %s: %s" % (label, path, to_text(ex)))
    if el["kind"] not in _SIMPLE and (el.get("click") or el.get("goto") or el.get("dialog") or el.get("close_dialog") or el.get("login")):
        # Image elements have no input handling: an input action there makes CODESYS's
        # code generation raise an assertion dialog. Click areas are simple shapes.
        warnings.append("%s: input actions only go on shapes, not on %s" % (label, el["kind"]))
        el = dict(el)
        for k in ("click", "goto", "dialog", "close_dialog", "login"):
            el.pop(k, None)
    if el.get("click"):
        try:
            e.add_input_action(visu.input_action_factory.create_execute_st_code(el["click"]), se.InputActionEventType.OnMouseClick)
        except Exception as ex:
            warnings.append("%s click: %s" % (label, to_text(ex)))
    if el.get("goto"):
        try:
            act = visu.input_action_factory.create_change_shown_visualization(se.ChangeShownVisualizationType.Assignment, el["goto"])
            e.add_input_action(act, se.InputActionEventType.OnMouseClick)
        except Exception as ex:
            warnings.append("%s goto: %s" % (label, to_text(ex)))
    if el.get("dialog"):
        try:
            from System.Collections.Generic import Dictionary, List
            d = el["dialog"]
            act = visu.input_action_factory.create_open_dialog(d["name"], Dictionary[object, object](), List[object](), True, False, str(int(d.get("x", 200))), str(int(d.get("y", 120))))
            e.add_input_action(act, se.InputActionEventType.OnMouseClick)
        except Exception as ex:
            warnings.append("%s dialog: %s" % (label, to_text(ex)))
    if el.get("login"):
        try:
            lt = _find_type("_3S.CoDeSys.VisualElem.VisuUserMgmtInputActionFactory")
            import System
            act = System.Activator.CreateInstance(lt).CreateInputAction()
            e.add_input_action(act, se.InputActionEventType.OnMouseClick)
        except Exception as ex:
            warnings.append("%s login: %s" % (label, to_text(ex)))
    if el.get("close_dialog"):
        try:
            act = visu.input_action_factory.create_close_dialog(el["close_dialog"], "OK")
            e.add_input_action(act, se.InputActionEventType.OnMouseClick)
        except Exception as ex:
            warnings.append("%s close: %s" % (label, to_text(ex)))
    if el.get("radius"):
        corners.append((eid, int(el["radius"])))


def _finish_page(c, visu, args, access, wrapped, corners, warnings):
    """One last transaction: access rights, the background, corner radii and line breaks."""
    rights = _access_rights(c, access, warnings) if access else {}
    try:
        with _Modify(c.proj, visu) as vo:
            for eid, lst in rights.items():
                el = vo.FindElementById(eid)
                if el is not None:
                    el.UserManagementAccessRights = lst
            if args.get("background") is not None:
                import System
                bg = vo.VisualElemList.Background
                bg.UseBackgroundColor = True
                v = int(args["background"])
                bg.BackgroundColor = System.Int32(v - 0x100000000 if v >= 0x80000000 else v)
            # A radius only counts with the Explicit radius type (else the style's rounding is drawn).
            for eid, r in corners:
                el = vo.FindElementById(eid)
                if el is not None:
                    el.GetVisualElemMember("m_Radius.m_RadiusSelectedValue", True, "VISU_ST_EXPLICIT").Value = "VISU_ST_EXPLICIT"
                    el.GetVisualElemMember("m_Radius.m_iRadius", True, r).Value = r
            # Text format: Line break (VisuEnumTextFlag NONE, LINEBREAK, ELLIPSIS).
            for eid in wrapped:
                el = vo.FindElementById(eid)
                if el is not None:
                    el.GetVisualElemMember("m_pStaticTextProperties..TextFlag", True, "LINEBREAK").Value = "LINEBREAK"
    except Exception as ex:
        warnings.append("background/corners: %s" % to_text(ex))


def _visu_groups(c):
    """name (lower case) -> id of the visualization user groups."""
    vmg = _find_child_deep(c, "Visualization Manager")
    if vmg is None:
        return {}
    vm = _object_mgr().GetObjectToRead(c.proj.handle, vmg.guid).Object
    um = getattr(vm, "VisuUserMgmt", None)
    out = {}
    if um is not None:
        for g in um.GetGroups():
            out[to_text(g.Name).lower()] = (to_text(g.Name), int(g.Id))
    return out


def _access_rights(c, access, warnings):
    """Element id -> CODESYS access-right list (VisuAccessRightInfo per user group). The
    groups are created first when missing (the Visualization Manager exists by now)."""
    import System
    from System.Collections import ArrayList
    import mcp_alarms
    # "None" (ID 0) is CODESYS's own group for a client where nobody is logged in.
    names = []
    for _, rights in access:
        for g, _r in rights:
            if g not in names and g.lower() != "none":
                names.append(g)
    have = _visu_groups(c)
    if [n for n in names if n.lower() not in have]:
        try:
            mcp_alarms.op_visu_users({"groups": names, "save": False})
        except Exception as ex:
            warnings.append("user groups for access rights: %s" % to_text(ex)[:160])
        have = _visu_groups(c)
    T = _find_type("_3S.CoDeSys.VisualElem.VisuAccessRightInfo")
    E = _find_type("_3S.CoDeSys.VisualElem.VisuAccessRightType")
    if T is None or E is None:
        warnings.append("access rights: this CODESYS has no element access rights to script")
        return {}
    out = {}
    for eid, rights in access:
        lst = ArrayList()
        for g, r in rights:
            found = have.get(g.lower()) or ((g, 0) if g.lower() == "none" else None)
            if found is None:
                if len(warnings) < 40:
                    warnings.append("access rights: no user group %s" % g)
                continue
            lst.Add(System.Activator.CreateInstance(T, found[0], found[1], System.Enum.Parse(E, r)))
        out[eid] = lst
    return out


def _visual_property(c, visu, size, dialog):
    """The visualization's own settings: canvas size, and whether it is a dialog."""
    import System
    SD = _drawing()
    mgr = _object_mgr()
    mo = mgr.GetObjectToModify(c.proj.handle, visu.guid)
    ok = False
    try:
        props = [p for p in mo.Properties if p.GetType().Name == "VisualProperty"]
        if props:
            vp = props[0]
            if size:
                vp.Size = SD.Size(int(size[0]), int(size[1]))
            if dialog:
                vp.UsageType = System.Enum.Parse(_find_type("_3S.CoDeSys.VisualObject.VisualUsageType"), "Dialog")
        ok = True
    finally:
        mgr.SetObject(mo, ok, None)


def op_visu_manager(args):
    """Start page, client size and style of the Visualization Manager, TargetVisu and WebVisu."""
    import System
    c = Ctx()
    SD = _drawing()
    done, warnings = [], []
    style = None
    if args.get("style"):
        repo = _static("_3S.CoDeSys.VisualEditor.APEnvironment", "VisualizationStylesRepository")
        for st in (repo.GetAllStyles() if repo is not None else []):
            nm = to_text(_get(st, "Name") or "")
            if nm.lower() == args["style"].lower():
                style = to_text(_get(st, "DisplayName"))
        if style is None:
            warnings.append("style %s is not installed" % args["style"])
    for name in ("Visualization Manager", "TargetVisu", "WebVisu"):
        obj = _find_child_deep(c, name)
        if obj is None:
            continue
        try:
            with _Modify(c.proj, obj) as vo:
                vs = vo.ViewSettings
                if args.get("start"):
                    vs.StartVisu = args["start"]
                if name == "Visualization Manager":
                    if style:
                        vs.VisualizationStyle = style
                elif args.get("width") and args.get("height"):
                    try:
                        vs.ClientSizeMode = System.Enum.Parse(vs.ClientSizeMode.GetType(), "Specified")
                    except Exception:
                        pass
                    vs.ClientSize = SD.Size(int(args["width"]), int(args["height"]))
                    try:
                        vs.BestFit = True
                    except Exception:
                        pass
            done.append(name)
        except Exception as ex:
            warnings.append("%s: %s" % (name, to_text(ex)))
    return {"updated": done, "warnings": warnings, "saved": c.save_if(args)}


def _get(o, name):
    try:
        return getattr(o, name)
    except Exception:
        return None


# Objects CODESYS names in its own language (a German CODESYS makes a "Visualisierungsmanager"):
# found by their type, which is the same in every language, and by name only as a fallback.
TYPE_GUIDS = {
    "Visualization Manager": "4d3fdb8f-ab50-4c35-9d3a-d4bb9bb9a628",
    "TargetVisu": "bc63f5fa-d286-4786-994e-7b27e4f97bd5",
    "WebVisu": "0fdbf158-1ae0-47d9-9269-cd84be308e9d",
    "Alarm Configuration": "c0a56ce5-14a3-4757-ac56-3eab44c974b3",
}
ALARM_CLASS_TYPE = "b8b46f61-c7c1-4259-87e4-26fe674798f9"


def _type_of(ch):
    try:
        return to_text(ch.type).strip("{}").lower()
    except Exception:
        return ""


def _find_child_deep(c, name, under=None):
    root = under if under is not None else c.app
    want = TYPE_GUIDS.get(name)
    kids = list(root.get_children(True))
    if want:
        for ch in kids:
            if _type_of(ch) == want:
                return ch
    for ch in kids:
        if name_of(ch).lower() == name.lower():
            return ch
    return None


def op_visu_render(args):
    """Paints a visualization into a PNG (no editor or window needed)."""
    c = Ctx()
    visu = _find_child(c, args["name"])
    if visu is None:
        raise OpError("not_found", "No visualization named %s." % args["name"])
    mgr = _object_mgr()
    SD = _drawing()
    w, h = int(args.get("width") or 1280), int(args.get("height") or 720)
    bmp = SD.Bitmap(w, h)
    g = SD.Graphics.FromImage(bmp)
    try:
        g.Clear(SD.Color.White)
        mgr.GetObjectToRead(c.proj.handle, visu.guid).Object.Paint(g, SD.Rectangle(0, 0, w, h))
    finally:
        g.Dispose()
    path = args["path"]
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    bmp.Save(path, SD.Imaging.ImageFormat.Png)
    bmp.Dispose()
    return {"path": path}


def op_ui_open(args):
    """With CODESYS's window: open an object in its editor (brings its tab forward)."""
    import os
    import mcp_ui
    if os.environ.get("CODESYS_MCP_UI") != "1":
        raise OpError("unavailable", "CODESYS runs without its window. Start the toolkit with --show-window to see objects in CODESYS.")
    c = Ctx()
    obj = c.resolve(args["path"])
    state = mcp_ui.open_editor(se, obj)
    if state == "unavailable":
        raise OpError("unavailable", "This CODESYS doesn't let scripts open editors.")
    out = {"path": c.path_of(obj), "opened": state}
    if state == "opened":
        # A visualization: show the whole page, not its top-left corner at 100 %.
        try:
            o = _object_mgr().GetObjectToRead(c.proj.handle, obj.guid).Object
            if o.GetType().FullName == "_3S.CoDeSys.VisualObject.VisualObject":
                se.system.delay(300)
                zoom = mcp_ui.fit_visualization(se, (o.Size.Width, o.Size.Height), str(obj.guid))
                if zoom is not None:
                    out["zoom"] = round(zoom * 100)
        except Exception as e:
            out["zoom_error"] = to_text(e)[:160]
    return out


mcp_ops.OPS.update({
    "ui.open": op_ui_open,
    "visu.manager": op_visu_manager,
    "visu.build": op_visu_build,
    "visu.render": op_visu_render,
})
