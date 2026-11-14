# -*- coding: utf-8 -*-
# Native CODESYS visualizations, built from a plan the server computes (src/hmi/native.ts).
#
# Two routes, both CODESYS's own:
# - the visualization script driver (create_visualobject, add_element, set_property with
#   property-view paths) for image switchers, bindings, colour toggles, movement, inputs;
# - CODESYS's element creators (the objects its toolbox uses) for what the property paths
#   can't set: a static font, a gradient, a hidden frame or fill. Added through CODESYS's
#   object manager, like the toolbox does.
# Rounded corners and the canvas background are members of CODESYS's element objects that
# were checked alone. Nothing here writes other raw members (some raise assertion dialogs).
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


def _add_created(proj, visu, cr, name):
    elem = cr.CreateVisualElement(name)
    with _Modify(proj, visu) as vo:
        elem.Id = vo.UniqueId
        elem.OwningObjectGuid = vo.MetaObject.ObjectGuid
        vo.VisualElemList.Add(elem)
        return elem.Id


def _script_element(visu, eid):
    for e in visu.visual_element_list:
        if e.id == eid:
            return e
    return None


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
    T = se.VisualElementType
    corners = []
    for i, el in enumerate(args.get("elements") or []):
        label = el.get("name") or "E%d" % i
        try:
            if el["kind"] in _SIMPLE:
                eid = _add_created(c.proj, visu, _simple_creator(el), label)
                e = _script_element(visu, eid)
            else:
                e = visu.visual_element_list.add_element({"switcher": T.ImageSwitcher, "image": T.Image}[el["kind"]])
                for p, v in (("Position.X", el["x"]), ("Position.Y", el["y"]), ("Position.Width", el["w"]), ("Position.Height", el["h"])):
                    e.set_property(p, int(v))
                eid = e.id
        except Exception as ex:
            warnings.append("%s: not added: %s" % (label, to_text(ex)))
            continue
        for path, v in (el.get("props") or {}).items():
            try:
                e.set_property(path, _value(v))
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
    try:
        with _Modify(c.proj, visu) as vo:
            if args.get("background") is not None:
                import System
                bg = vo.VisualElemList.Background
                bg.UseBackgroundColor = True
                v = int(args["background"])
                bg.BackgroundColor = System.Int32(v - 0x100000000 if v >= 0x80000000 else v)
            for eid, r in corners:
                el = vo.FindElementById(eid)
                if el is not None:
                    el.GetVisualElemMember("m_Radius.m_iRadius", True, r).Value = r
    except Exception as ex:
        warnings.append("background/corners: %s" % to_text(ex))
    return {"name": name_of(visu), "path": name_of(visu), "kind": "visualization", "elements": len(visu.visual_element_list), "warnings": warnings, "saved": c.save_if(args)}


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


def _find_child_deep(c, name):
    for ch in c.app.get_children(True):
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


mcp_ops.OPS.update({
    "visu.manager": op_visu_manager,
    "visu.build": op_visu_build,
    "visu.render": op_visu_render,
})
