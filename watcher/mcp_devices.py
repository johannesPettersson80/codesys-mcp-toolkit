# -*- coding: utf-8 -*-
# Devices from CODESYS's device repository: search the installed device
# descriptions (fieldbus masters and slaves, I/O modules) and add or plug one into
# the device tree. Documented scripting API (device_repository, ScriptDeviceObject).
# Offline only: nothing here goes online.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import mcp_ops
import mcp_sim
from mcp_ops import Ctx, OpError, _safe
from mcp_compat import to_text

import scriptengine as se


def _desc(d):
    did = _safe(lambda: d.device_id)
    out = {
        "name": to_text(_safe(lambda: d.name, "")),
        "vendor": to_text(_safe(lambda: d.vendor, "")),
        "description": to_text(_safe(lambda: d.description, "") or "")[:200],
    }
    if did is not None:
        out["type"] = int(_safe(lambda: did.type, 0))
        out["id"] = to_text(_safe(lambda: did.id, ""))
        out["version"] = to_text(_safe(lambda: did.version, ""))
    order = _safe(lambda: d.order_number)
    if order:
        out["order_number"] = to_text(order)
    return out


def op_devices_search(args):
    repo = _safe(lambda: se.device_repository)
    if repo is None:
        raise OpError("unavailable", "This CODESYS has no device repository in scripting.")
    text = args.get("text") or ""
    found = repo.get_all_devices(name=text, source=None)
    out = []
    for d in found or []:
        full = d
        if not to_text(_safe(lambda: d.name, "") or ""):
            did = _safe(lambda: d.device_id)
            full = (_safe(lambda: repo.get_device(did)) if did is not None else None) or d
        item = _desc(full)
        if not item["name"]:
            info = _safe(lambda: full.device_info)
            item["name"] = to_text(_safe(lambda: info.name, "") or "")
            item["vendor"] = item["vendor"] or to_text(_safe(lambda: info.vendor, "") or "")
            item["description"] = item["description"] or to_text(_safe(lambda: info.description, "") or "")[:200]
        out.append(item)
        if len(out) >= int(args.get("limit") or 40):
            break
    return {"devices": out, "more": len(found or []) > len(out)}


def op_devices_add(args):
    c = Ctx()
    parent = c.resolve(args["parent"])
    if not _safe(lambda: parent.is_device, False):
        raise OpError("bad_path", "%s is not a device (add devices under a device or a connector's device, e.g. '/Device')." % args["parent"])
    how = args.get("how") or "add"
    module = args.get("module")
    if how == "plug":
        parent.plug(args["name"], int(args["type"]), args["id"], args["version"], module)
        dev = parent
    else:
        fn = parent.add if how == "add" else parent.insert
        if how == "insert":
            parent.insert(args["name"], int(args.get("index") or 0), int(args["type"]), args["id"], args["version"], module)
        else:
            fn(args["name"], int(args["type"]), args["id"], args["version"], module)
        dev = None
        for ch in parent.get_children(False):
            if to_text(_safe(lambda: ch.get_name(), "")).lower() == args["name"].lower():
                dev = ch
        if dev is None:
            raise OpError("codesys_error", "CODESYS added nothing named %s under %s." % (args["name"], args["parent"]))
    return {"path": c.path_of(dev), "saved": c.save_if(args)}


mcp_ops.OPS["devices.search"] = op_devices_search
mcp_ops.OPS["devices.add"] = mcp_sim._locked(op_devices_add)
