# Fake CODESYS scriptengine for running the real watcher under CPython 3 in tests.
# Mirrors the parts of the API the watcher uses; behaviour hooks:
#   implementation text containing "__HANG__"  -> replace() blocks forever
#   implementation text containing "__CRASH__" -> the process exits
#   implementation text containing "ERROR_HERE" -> build() reports an error there
import json
import os
import time
import uuid

FAKE = True

G_POU = "6f9dac99-8de1-4efc-8465-68ac443b7d08"
G_METHOD = "f8a58466-d7f6-439f-bbb8-d4600e41d099"
G_PROP = "5a3b8626-d3e9-4f37-98b5-66420063d91e"
G_ACC = "792f2eb6-721e-4e64-ba20-bc98351056db"
G_ACTION = "8ac092e5-3128-4e26-9e7e-11016c6684f2"
G_DUT = "2db5746d-d284-4425-9f7f-2663a34b0ebc"
G_GVL = "ffbfa93a-b94d-45fc-a329-229860183b1d"
G_ITF = "6654496c-404d-479a-aad2-8551054e5f1e"
G_ITF_METHOD = "f89f7675-27f1-46b3-8abb-b7da8e774ffd"
G_TASKCFG = "ae1de277-a207-4a28-9efb-456c06bd52f3"
G_TASK = "98a2708a-9b18-4f31-82ed-a1465b24fa2d"
G_LIBMAN = "adb5cb65-8e1d-4a00-b70a-375ea27582f3"
G_DEVICE = "225bfe47-7336-4dbc-9419-4105a7c831fa"
G_PLCLOGIC = "40b404f9-e5dc-42c6-907f-c89f4a517386"
G_APP = "639b491f-5557-464c-af91-1471bac9f549"
G_FOLDER = "738bea1e-99bb-4f04-90bb-a7a567e74e3a"


class _Enum(object):
    def __init__(self, name, value):
        self.name, self.value = name, value

    def __or__(self, other):
        return _Enum(self.name + "|" + other.name, self.value | other.value)

    def __str__(self):
        return self.name


class VersionUpdateFlags(object):
    NoUpdates = _Enum("NoUpdates", 1)
    SilentMode = _Enum("SilentMode", 2)


class PouType(object):
    Program = "Program"
    FunctionBlock = "FunctionBlock"
    Function = "Function"


class DutType(object):
    Structure = "Structure"
    Enumeration = "Enumeration"
    Alias = "Alias"
    Union = "Union"


class PromptHandling(object):
    LogSimplePrompts = _Enum("LogSimplePrompts", 2)


class _Text(object):
    def __init__(self, text):
        self.text = text

    def replace(self, new):
        if "__HANG__" in new:
            time.sleep(3600)
        if "__CRASH__" in new:
            os._exit(3)
        self.text = new


class FakeObject(object):
    def __init__(self, name, type_guid, parent=None, decl=None, impl=None, folder=False, graphical=False):
        self._name = name
        self.type = type_guid
        self.guid = str(uuid.uuid4())
        self.parent = parent
        self.is_folder = folder
        self.is_device = type_guid == G_DEVICE
        self._children = []
        self._decl = _Text(decl) if decl is not None else None
        self._impl = _Text(impl) if impl is not None else None
        self._graphical = graphical
        if parent is not None:
            parent._children.append(self)

    # tree
    def get_name(self):
        return self._name

    def get_children(self, recursive=False):
        if not recursive:
            return list(self._children)
        out = []
        for c in self._children:
            out.append(c)
            out.extend(c.get_children(True))
        return out

    def remove(self):
        self.parent._children.remove(self)
        _mark_dirty()

    def rename(self, new):
        self._name = new
        _mark_dirty()

    # text
    @property
    def has_textual_declaration(self):
        return self._decl is not None

    @property
    def has_textual_implementation(self):
        return self._impl is not None and not self._graphical

    @property
    def textual_declaration(self):
        return self._decl

    @property
    def textual_implementation(self):
        return self._impl if not self._graphical else None

    # creation
    def _check(self, name):
        if any(c._name.lower() == name.lower() for c in self._children):
            raise Exception("An object named %s already exists" % name)

    def create_pou(self, name, type=PouType.Program, language=None, return_type=None):
        self._check(name)
        if type == PouType.Function and not return_type:
            raise ValueError("Specified argument was out of the range of valid values.\nParameter name: return_type")
        kw = {"Program": "PROGRAM", "FunctionBlock": "FUNCTION_BLOCK", "Function": "FUNCTION"}[type]
        head = "%s %s%s" % (kw, name, (" : " + return_type) if return_type else "")
        _mark_dirty()
        return FakeObject(name, G_POU, self, head + "\nVAR\nEND_VAR\n", "")

    def create_method(self, name, return_type=None, language=None):
        self._check(name)
        g = G_ITF_METHOD if self.type == G_ITF else G_METHOD
        _mark_dirty()
        return FakeObject(name, g, self, "METHOD %s%s\nVAR_INPUT\nEND_VAR\n" % (name, (" : " + return_type) if return_type else ""),
                          None if g == G_ITF_METHOD else "")

    def create_property(self, name, return_type="int", language=None):
        self._check(name)
        p = FakeObject(name, G_PROP, self, "PROPERTY %s : %s\n" % (name, return_type))
        FakeObject("Get", G_ACC, p, "VAR\nEND_VAR\n", "")
        FakeObject("Set", G_ACC, p, "VAR\nEND_VAR\n", "")
        _mark_dirty()
        return p

    def create_action(self, name, language=None):
        self._check(name)
        _mark_dirty()
        return FakeObject(name, G_ACTION, self, None, "")

    def create_interface(self, name, baseInterfaces="__System.IQueryInterface"):
        self._check(name)
        ext = (" EXTENDS " + baseInterfaces) if baseInterfaces else ""
        _mark_dirty()
        return FakeObject(name, G_ITF, self, "INTERFACE %s%s\n" % (name, ext))

    def create_dut(self, name, type=DutType.Structure, baseType=None):
        self._check(name)
        body = {"Structure": "STRUCT\nEND_STRUCT", "Enumeration": "(\n    A := 0\n)", "Alias": "INT", "Union": "UNION\nEND_UNION"}[type]
        _mark_dirty()
        return FakeObject(name, G_DUT, self, "TYPE %s :\n%s\nEND_TYPE\n" % (name, body))

    def create_gvl(self, name):
        self._check(name)
        _mark_dirty()
        return FakeObject(name, G_GVL, self, "VAR_GLOBAL\nEND_VAR\n")

    def create_folder(self, name):
        self._check(name)
        _mark_dirty()
        return FakeObject(name, G_FOLDER, self, folder=True)

    # application
    def build(self):
        system._messages = []
        system._messages.append(_Msg("Text", "------ Build started: Application: Device.Application -------"))
        errors = 0
        for o in self.get_children(True):
            impl = o._impl.text if o._impl is not None else ""
            if "ERROR_HERE" in impl:
                errors += 1
                system._messages.append(_Msg("Error", "Unknown identifier 'ERROR_HERE'", o, "Line 1, Column 1 (Impl)", "C", 46))
        system._messages.append(_Msg("Text", "Compile complete -- %d errors, 0 warnings" % errors))


class FakeLibMan(FakeObject):
    def __init__(self, parent):
        FakeObject.__init__(self, "Library Manager", G_LIBMAN, parent)
        self._libs = ["Standard, * (System)", "Util, * (System)"]

    @property
    def references(self):
        return [_LibRef(n) for n in self._libs]

    def get_libraries(self, recursive=False):
        return list(self._libs)

    def add_library(self, name):
        if "," not in name:
            raise Exception("Library '%s' not found in repository" % name)
        self._libs.append(name)
        _mark_dirty()


class _LibRef(object):
    def __init__(self, name):
        self.name = name
        self.is_placeholder = False
        self.is_managed = True


class FakeTask(FakeObject):
    def __init__(self, name, parent, pous):
        FakeObject.__init__(self, name, G_TASK, parent)
        self.interval = "t#20ms"
        self.interval_unit = "ms"
        self.priority = "1"
        self.kind_of_task = "Cyclic"
        self.pous = list(pous)


class _Msg(object):
    def __init__(self, severity, text, obj=None, pos=None, prefix=None, number=None):
        self.severity, self.text, self.object, self.position_text = severity, text, obj, pos
        self.prefix, self.number = prefix, number


class FakeProject(object):
    def __init__(self, path):
        self.path = path
        self.dirty = False
        self._roots = []
        self.active_application = None

    def get_children(self, recursive=False):
        return list(self._roots)

    def get_name(self):  # CODESYS projects don't expose this; mimic by raising
        raise AttributeError("get_name")

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(_dump(self), f, ensure_ascii=False)
        self.dirty = False

    def close(self):
        projects.primary = None


def _mark_dirty():
    if projects.primary is not None:
        projects.primary.dirty = True


def _sample(proj):
    dev = FakeObject("Device", G_DEVICE, None)
    proj._roots.append(dev)
    plc = FakeObject("Plc Logic", G_PLCLOGIC, dev)
    app = FakeObject("Application", G_APP, plc)
    proj.active_application = app
    FakeLibMan(app)
    FakeObject("PLC_PRG", G_POU, app, "PROGRAM PLC_PRG\nVAR\n    nCount : INT;\nEND_VAR\n", "nCount := nCount + 1;\n")
    fb = FakeObject("FB_Pump", G_POU, app, "FUNCTION_BLOCK FB_Pump\nVAR_INPUT\n    bRun : BOOL;\nEND_VAR\nVAR\n    _rSpeed : REAL;\nEND_VAR\n", "")
    FakeObject("Start", G_METHOD, fb, "METHOD Start : BOOL\n", "Start := TRUE;\n")
    p = FakeObject("Speed", G_PROP, fb, "PROPERTY Speed : REAL\n")
    FakeObject("Get", G_ACC, p, "VAR\nEND_VAR\n", "Speed := _rSpeed;\n")
    FakeObject("Set", G_ACC, p, "VAR\nEND_VAR\n", "_rSpeed := Speed;\n")
    FakeObject("SEQ_Fill", G_POU, app, "PROGRAM SEQ_Fill\nVAR\nEND_VAR\n", "", graphical=True)
    FakeObject("E_Mode", G_DUT, app, "{attribute 'qualified_only'}\nTYPE E_Mode :\n(\n    MANUAL := 0,\n    AUTO := 1\n);\nEND_TYPE\n")
    FakeObject("GVL_IO", G_GVL, app, "VAR_GLOBAL\n    rLevel : REAL;\nEND_VAR\n")
    cfg = FakeObject("Taskkonfiguration", G_TASKCFG, app)
    FakeTask("MainTask", cfg, ["PLC_PRG"])


def _dump(proj):
    def rec(o):
        d = {"name": o._name, "type": o.type, "folder": o.is_folder, "graphical": o._graphical,
             "decl": o._decl.text if o._decl else None, "impl": o._impl.text if o._impl else None,
             "app": o is proj.active_application, "children": [rec(c) for c in o._children]}
        if isinstance(o, FakeLibMan):
            d["libs"] = o._libs
        if isinstance(o, FakeTask):
            d["pous"] = o.pous
        return d
    return {"fake": True, "roots": [rec(r) for r in proj._roots]}


def _load(proj, data):
    def rec(d, parent):
        if d["type"] == G_LIBMAN:
            o = FakeLibMan(parent)
            o._libs = d.get("libs", [])
        elif d["type"] == G_TASK:
            o = FakeTask(d["name"], parent, d.get("pous", []))
        else:
            o = FakeObject(d["name"], d["type"], parent, d["decl"], d["impl"], d["folder"], d["graphical"])
        if parent is None:
            proj._roots.append(o)
        if d.get("app"):
            proj.active_application = o
        for c in d["children"]:
            rec(c, o)
    for r in data["roots"]:
        rec(r, None)


class _Projects(object):
    def __init__(self):
        self.primary = None

    def open(self, path, update_flags=None):
        proj = FakeProject(path)
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        if raw.startswith("{"):
            _load(proj, json.loads(raw))
        else:
            _sample(proj)
        self.primary = proj
        return proj

    def create(self, path, primary=True):
        proj = FakeProject(path)
        self.primary = proj
        return proj


class _System(object):
    def __init__(self):
        self._messages = []
        self.prompt_handling = None

    def get_message_categories(self, active=True):
        return ["{97F48D64-A2A3-4856-B640-75C046E37EA9}", "{194B48A9-AB51-43ae-B9A9-51D3EDAADDF3}"]

    def get_message_category_description(self, cat):
        return "Build" if cat.startswith("{97") else "Script Messages"

    def get_message_objects(self, cat, severities=None):
        return list(self._messages) if cat.startswith("{97") else []


projects = _Projects()
system = _System()
