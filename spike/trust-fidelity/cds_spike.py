# -*- coding: utf-8 -*-
# Spike (IronPython 2.7, CODESYS scriptengine): add the tank demo + dialect
# probe to a COPY of a project, build it, collect build messages, and export
# every textual object to JSON. One-off; not v2 code.
# Args via env: SPIKE_PROJECT, SPIKE_SRC, SPIKE_OUT
from __future__ import print_function
import os, sys, codecs, json, traceback
from scriptengine import *

PROJ = os.environ["SPIKE_PROJECT"]
SRC = os.environ["SPIKE_SRC"]
OUT = os.environ["SPIKE_OUT"]

result = {"steps": [], "errors": [], "messages": [], "objects": []}

def step(msg):
    result["steps"].append(msg)
    print("STEP: " + msg)

def err(where, e):
    result["errors"].append({"where": where, "error": unicode(e), "trace": traceback.format_exc()})
    print("ERR: %s: %s" % (where, e))

def src(name):
    p = os.path.join(SRC, name)
    if not os.path.exists(p):
        return None
    f = codecs.open(p, "r", "utf-8-sig")
    try:
        return f.read()
    finally:
        f.close()

def put(obj, base):
    d = src(base + ".decl.st")
    i = src(base + ".impl.st")
    if d is not None:
        obj.textual_declaration.replace(d)
    if i is not None:
        obj.textual_implementation.replace(i)

def find_child(parent, name):
    for c in parent.get_children(False):
        if c.get_name() == name:
            return c
    return None

def remove_if_exists(parent, name):
    c = find_child(parent, name)
    if c is not None:
        c.remove()
        step("removed existing " + name)

try:
    try:
        system.script_prompt_handling = ScriptPromptHandling.LogPrompts
        step("prompt handling = LogPrompts")
    except Exception as e:
        err("prompt_handling", e)

    proj = projects.open(PROJ)
    step("opened " + PROJ)
    app = proj.active_application
    step("active application: " + app.get_name())

    for n in ["E_TankMode", "I_Resettable", "FB_PI", "FB_Probe", "GVL_IO", "GVL_Par", "PRG_Tank", "FB_Broken"]:
        remove_if_exists(app, n)

    def attempt(label, fn):
        try:
            r = fn()
            step("ok " + label)
            return r
        except Exception as e:
            err(label, e)
            return None

    dut = attempt("create_dut E_TankMode", lambda: app.create_dut("E_TankMode", DutType.Enumeration))
    if dut: attempt("text E_TankMode", lambda: put(dut, "E_TankMode"))

    itf = attempt("create_interface I_Resettable", lambda: app.create_interface("I_Resettable"))
    if itf:
        m = attempt("create interface method Reset", lambda: itf.create_method("Reset", "BOOL"))
        if m: attempt("text I_Resettable.Reset", lambda: put(m, "I_Resettable.Reset"))

    fb = attempt("create_pou FB_PI", lambda: app.create_pou("FB_PI", PouType.FunctionBlock))
    if fb:
        attempt("text FB_PI", lambda: put(fb, "FB_PI"))
        m = attempt("create_method FB_PI.Reset", lambda: fb.create_method("Reset", "BOOL"))
        if m: attempt("text FB_PI.Reset", lambda: put(m, "FB_PI.Reset"))
        for pname in ["Kp", "Ti"]:
            p = attempt("create_property FB_PI." + pname, lambda: fb.create_property(pname, "REAL"))
            if p:
                for acc in p.get_children(False):
                    an = acc.get_name()
                    attempt("text FB_PI.%s.%s" % (pname, an), lambda: put(acc, "FB_PI.%s.%s" % (pname, an)))

    pr = attempt("create_pou FB_Probe", lambda: app.create_pou("FB_Probe", PouType.FunctionBlock))
    if pr:
        attempt("text FB_Probe", lambda: put(pr, "FB_Probe"))
        for mname, rt in [("FB_init", "BOOL"), ("Count", "INT")]:
            m = attempt("create_method FB_Probe." + mname, lambda: pr.create_method(mname, rt))
            if m: attempt("text FB_Probe." + mname, lambda: put(m, "FB_Probe." + mname))
        a = attempt("create_action FB_Probe.ACT_Clear", lambda: pr.create_action("ACT_Clear"))
        if a: attempt("text FB_Probe.ACT_Clear", lambda: put(a, "FB_Probe.ACT_Clear"))

    for g in ["GVL_IO", "GVL_Par"]:
        o = attempt("create_gvl " + g, lambda: app.create_gvl(g))
        if o: attempt("text " + g, lambda: put(o, g))

    prg = attempt("create_pou PRG_Tank", lambda: app.create_pou("PRG_Tank", PouType.Program))
    if prg: attempt("text PRG_Tank", lambda: put(prg, "PRG_Tank"))

    brk = attempt("create_pou FB_Broken (unreferenced)", lambda: app.create_pou("FB_Broken", PouType.FunctionBlock))
    if brk: attempt("text FB_Broken", lambda: put(brk, "FB_Broken"))

    # Wire PRG_Tank into the cyclic task (find tasks by type GUID, names are localised)
    TASK_GUID = "98a2708a"
    def find_type(o, prefix, acc):
        for c in o.get_children(False):
            if unicode(c.type).lower().startswith(prefix):
                acc.append(c)
            find_type(c, prefix, acc)
        return acc
    tasks = find_type(app, TASK_GUID, [])
    step("tasks: " + ", ".join([t.get_name() for t in tasks]))
    if tasks:
        t = tasks[0]
        def pou_names():
            return [unicode(getattr(x, "pou_name", None) or getattr(x, "name", None) or x) for x in t.pous]
        def add_call():
            if "PRG_Tank" not in pou_names():
                t.pous.add("PRG_Tank")
            return pou_names()
        r = attempt("task.pous.add PRG_Tank", add_call)
        if r is not None: step("task calls: " + ", ".join(r))

    # Probe prompt-handling names for v2
    for expr in ["system.script_prompt_handling", "ScriptSystem", "PromptHandling", "system.prompt_handling"]:
        try:
            step("probe %s = %s" % (expr, eval(expr)))
        except Exception as e:
            step("probe %s FAILED: %s" % (expr, e))

    # Build and collect messages from every category
    attempt("build", lambda: app.build())
    # NOTE: proj.check_all_pool_objects() starts another build that clears the
    # Build message category and does not catch unreferenced POUs -> not used.
    try:
        for cat in system.get_message_categories(True):
            try:
                desc = system.get_message_category_description(cat)
            except Exception:
                desc = ""
            for m in system.get_message_objects(cat):
                o = None
                try:
                    o = m.object.get_name() if m.object is not None else None
                except Exception:
                    pass
                extra = {}
                for k in ["position", "position_text", "position_offset", "project"]:
                    try:
                        extra[k] = unicode(getattr(m, k))
                    except Exception as e:
                        extra[k] = "ERR " + unicode(e)
                try:
                    extra["object_type"] = unicode(m.object.type) if m.object is not None else None
                    extra["object_parent"] = m.object.parent.get_name() if m.object is not None else None
                except Exception:
                    pass
                result["messages"].append({
                    "category": unicode(desc), "severity": unicode(m.severity),
                    "text": unicode(m.text), "object": o,
                    "position": unicode(getattr(m, "position_text", "") or ""), "extra": extra})
        step("collected %d messages" % len(result["messages"]))
    except Exception as e:
        err("messages", e)

    # Export every textual object under the application
    def path_of(o):
        parts = []
        cur = o
        while cur is not None and cur != app:
            try:
                parts.insert(0, cur.get_name())
                cur = cur.parent
            except Exception:
                break
        return "/".join(parts)

    def walk(o):
        for c in o.get_children(False):
            rec = {"path": path_of(c), "name": c.get_name(), "type": unicode(c.type),
                   "is_folder": bool(getattr(c, "is_folder", False))}
            try:
                if c.has_textual_declaration:
                    rec["decl"] = c.textual_declaration.text
            except Exception as e:
                rec["decl_err"] = unicode(e)
            try:
                if c.has_textual_implementation:
                    rec["impl"] = c.textual_implementation.text
            except Exception as e:
                rec["impl_err"] = unicode(e)
            result["objects"].append(rec)
            walk(c)
    walk(app)
    step("exported %d objects" % len(result["objects"]))

    proj.save()
    step("saved")
    proj.close()
except Exception as e:
    err("fatal", e)

f = codecs.open(OUT, "w", "utf-8")
try:
    f.write(json.dumps(result, ensure_ascii=False, indent=1))
finally:
    f.close()
print("SPIKE_DONE")
