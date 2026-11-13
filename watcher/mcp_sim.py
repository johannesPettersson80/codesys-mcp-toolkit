# -*- coding: utf-8 -*-
# CODESYS's own simulation: runs the active application inside CODESYS, with no
# controller involved. Runs inside CODESYS (IronPython 2.7) and under CPython 3
# with a fake scriptengine in tests. Keep this file ASCII-only.
#
# Every online call first checks that the device is in simulation mode, so these
# operations can't reach a controller. While a simulation runs the project is
# locked, so the simulation flag on the device is never saved into it.
from __future__ import print_function

import scriptengine as se

import mcp_ops
from mcp_compat import to_text
from mcp_ops import Ctx, OpError, _safe

SIM = {"online": None, "device": None, "project": None, "was_dirty": False, "forced": set(), "cycles": 0}

# Operations that change the project, or could save the simulation flag into it.
LOCKED = (
    "project.open", "project.open_new", "project.create_empty", "project.save", "project.close",
    "object.write", "object.create", "object.delete", "object.rename", "object.import_xml",
    "libraries.add", "libraries.remove", "task.configure", "build",
)

# Between single cycles: the command returns before the cycle has run.
CYCLE_PAUSE_MS = 100
MAX_CYCLES = 1000
# Long enough for CODESYS to refresh a value it monitors (see _read).
READ_SETTLE_MS = 150


def _require_simulation():
    device = SIM["device"]
    if device is None or not device.get_simulation_mode():
        raise OpError("not_simulating", "The device is not in simulation mode, so the toolkit won't go online.")


def _online():
    if SIM["online"] is None:
        raise OpError("not_running", "The CODESYS simulation isn't running. Call codesys_sim_start first.")
    _require_simulation()
    return SIM["online"]


def _pause(ms):
    if not hasattr(se, "FAKE"):
        se.system.delay(ms)


def _device_of(app):
    """The outermost device above the application."""
    found = None
    obj = app
    while obj is not None:
        if _safe(lambda: obj.is_device, False):
            found = obj
        obj = _safe(lambda: obj.parent)
    if found is None:
        raise OpError("no_device", "No device found above the application.")
    return found


def _status():
    online = SIM["online"]
    if online is None:
        return {"running": False}
    return {
        "running": True,
        "state": to_text(online.application_state),
        "operation": to_text(online.operation_state),
        "forced": sorted(SIM["forced"]),
        "cycles": SIM["cycles"],
    }


def _release():
    """Take the device out of simulation mode and leave the project as it was."""
    device, proj, was_dirty = SIM["device"], SIM["project"], SIM["was_dirty"]
    SIM.update({"online": None, "device": None, "project": None, "was_dirty": False, "forced": set(), "cycles": 0})
    if device is not None:
        device.set_simulation_mode(False)
    if proj is not None and not was_dirty:
        proj.save()  # same content as before; leaves no unsaved change behind


def _stop():
    online = SIM["online"]
    try:
        _safe(lambda: online.unforce_all_values())
        online.logout()
    finally:
        _release()


def op_sim_start(args):
    c = Ctx()
    if c.app is None:
        raise OpError("no_application", "The project has no active application to simulate.")
    if SIM["online"] is not None:
        _stop()
    # In a window the user has open (attach mode) the application may already be logged in,
    # perhaps to a real controller. Never take over that connection.
    if _safe(lambda: se.online.create_online_application(c.app).is_logged_in, False):
        raise OpError(
            "already_online",
            "The application is already logged in, possibly to a real controller. The toolkit only goes "
            "online to a simulation it starts itself: log out in the CODESYS window, then try again.",
        )
    SIM["was_dirty"] = bool(_safe(lambda: c.proj.dirty, False))
    SIM["project"] = c.proj
    SIM["device"] = _device_of(c.app)
    try:
        SIM["device"].set_simulation_mode(True)
        _require_simulation()
        online = se.online.create_online_application(c.app)
        online.login(se.OnlineChangeOption.Never, True)
    except BaseException:
        _release()
        raise
    SIM["online"] = online
    if args.get("run"):
        online.start()
    return _status()


def op_sim_stop(args):
    if SIM["online"] is not None:
        _stop()
    return _status()


def op_sim_status(args):
    return _status()


def op_sim_control(args):
    online = _online()
    action = args["action"]
    if action == "run":
        online.start()
    elif action == "stop":
        online.stop()
    elif action in ("reset_warm", "reset_cold"):
        online.reset(se.ResetOption.Warm if action == "reset_warm" else se.ResetOption.Cold, True)
        SIM["forced"].clear()  # a reset releases forced values
    else:
        raise OpError("bad_request", "Unknown action: %s" % action)
    return _status()


def op_sim_cycle(args):
    online = _online()
    count = int(args.get("count") or 1)
    if count < 1 or count > MAX_CYCLES:
        raise OpError("bad_request", "count must be between 1 and %d." % MAX_CYCLES)
    if to_text(online.application_state).lower() == "run":
        online.stop()
    command = se.system.commands["online", "singlecycleactiveapp"]
    for _ in range(count):
        command.execute()
        SIM["cycles"] += 1
        _pause(CYCLE_PAUSE_MS)
    return _status()


def _read(online, names):
    """Current values and errors by name. CODESYS answers from its monitoring cache, so
    the first read after a change can return the old value: read once, let it refresh, read again."""
    _read_once(online, names)
    _pause(READ_SETTLE_MS)
    return _read_once(online, names)


def _read_once(online, names):
    """Values and errors by name. One bad name must not hide the good ones."""
    try:
        return dict(zip(names, [to_text(v) for v in online.read_values(names)])), {}
    except Exception:
        values, errors = {}, {}
        for name in names:
            try:
                values[name] = to_text(online.read_value(name))
            except Exception as e:
                errors[name] = to_text(e)
        return values, errors


def op_sim_read(args):
    values, errors = _read(_online(), args["names"])
    return {"values": values, "errors": errors}


def _prepare(online, values):
    """Queue values, after checking every name, so a bad name leaves nothing queued."""
    names = sorted(values)
    errors = _read_once(online, names)[1]
    if errors:
        raise OpError("unknown_variable", "; ".join("%s: %s" % (n, errors[n]) for n in sorted(errors)))
    for name in names:
        online.set_prepared_value(name, to_text(values[name]))


def op_sim_write(args):
    online = _online()
    _prepare(online, args["values"])
    online.write_prepared_values()
    return _status()


def op_sim_force(args):
    online = _online()
    _prepare(online, args["values"])
    online.force_prepared_values()
    SIM["forced"].update(args["values"].keys())
    return _status()


def op_sim_unforce(args):
    online = _online()
    names = args.get("names")
    if names:
        for name in names:
            online.set_prepared_value(name, se.online.UNFORCE)
        online.force_prepared_values()
        SIM["forced"].difference_update(names)
    else:
        online.unforce_all_values()
        SIM["forced"].clear()
    return _status()


def _locked(fn):
    def run(args):
        if SIM["online"] is not None:
            raise OpError("simulation_running", "The CODESYS simulation is running, so the project is locked. Call codesys_sim_stop first.")
        return fn(args)
    return run


for _name in LOCKED:
    mcp_ops.OPS[_name] = _locked(mcp_ops.OPS[_name])

mcp_ops.OPS.update({
    "sim.start": op_sim_start,
    "sim.stop": op_sim_stop,
    "sim.status": op_sim_status,
    "sim.control": op_sim_control,
    "sim.cycle": op_sim_cycle,
    "sim.read": op_sim_read,
    "sim.write": op_sim_write,
    "sim.force": op_sim_force,
    "sim.unforce": op_sim_unforce,
})
