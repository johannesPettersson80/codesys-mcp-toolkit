# -*- coding: utf-8 -*-
# Devices from CODESYS's device repository: search the installed device
# descriptions (fieldbus masters and slaves, I/O modules) and add or plug one into
# the device tree. Documented scripting API (device_repository, ScriptDeviceObject).
# Offline only: nothing here goes online.
#
# Keep this file ASCII-only (IronPython 2.7 inside CODESYS).
import mcp_ops
import mcp_sim
from mcp_ops import Ctx, OpError, _safe, children, kind_of, name_of
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


def _param_sets(dev):
    """(prefix, parameter set) for the device itself and each of its connectors."""
    out = []
    ps = _safe(lambda: dev.device_parameters)
    if ps is not None:
        out.append(("", ps))
    conns = _safe(lambda: dev.connectors) or []
    for i, con in enumerate(conns):
        hp = _safe(lambda: con.host_parameters)
        if hp is not None and len(hp):
            out.append(("c%d/" % i, hp))
    return out


def _walk_elements(prefix, el, depth, out, limit):
    """Every data element under el, depth-first, keyed by its identifier path."""
    if len(out) >= limit:
        return
    ident = to_text(_safe(lambda: el.identifier, "") or "")
    key = prefix + ident
    has_sub = bool(_safe(lambda: el.has_sub_elements, False))
    item = {
        "key": key,
        "name": to_text(_safe(lambda: el.visible_name, "") or ""),
        "depth": depth,
    }
    desc = to_text(_safe(lambda: el.description, "") or "")
    if desc and desc != item["name"]:
        item["description"] = desc[:160]
    unit = to_text(_safe(lambda: el.unit, "") or "")
    if unit:
        item["unit"] = unit
    param = _safe(lambda: el.parameter)
    if depth == 0 and param is not None:
        sec = to_text(_safe(lambda: param.section, "") or "")
        if sec:
            item["section"] = sec
        t = to_text(_safe(lambda: param.type_string, "") or "")
        if t:
            item["type"] = t
        acc = to_text(_safe(lambda: param.offline_access_rights, "") or "")
        if acc:
            item["access"] = acc
    ch = to_text(_safe(lambda: el.parameter.channel_type, "") or "")
    if ch and ch.lower() not in ("none", "0"):
        item["channel"] = ch
    if not has_sub:
        v = _safe(lambda: el.value)
        if v is not None:
            item["value"] = to_text(v)
        d = _safe(lambda: el.default_value)
        if d:
            item["default"] = to_text(d)
        if _safe(lambda: el.is_enumeration, False):
            item["choices"] = [to_text(_safe(lambda: e.identifier, "")) + (("=" + to_text(e.visible_name)) if _safe(lambda: e.visible_name) else "") for e in (_safe(lambda: el.allowed_values) or [])][:40]
    if _safe(lambda: el.is_mappable_io, False):
        m = _safe(lambda: el.io_mapping)
        if m is not None:
            item["mapping"] = {
                "variable": to_text(_safe(lambda: m.variable, "") or ""),
                "address": to_text(_safe(lambda: m.manual_iec_address, "") or ""),
                "automatic_address": bool(_safe(lambda: m.automatic_iec_address, True)),
            }
    out.append(item)
    if has_sub:
        for sub in list(el):
            _walk_elements(key + "/", sub, depth + 1, out, limit)


def _device(c, path):
    dev = c.resolve(path)
    if not _safe(lambda: dev.is_device, False):
        raise OpError("bad_path", "%s is not a device (get_devices lists them)." % path)
    return dev


def op_devices_params(args):
    c = Ctx()
    dev = _device(c, args["path"])
    limit = int(args.get("limit") or 600)
    out = []
    for prefix, ps in _param_sets(dev):
        for p in ps:
            _walk_elements(prefix, p, 0, out, limit)
    return {"path": c.path_of(dev), "parameters": out, "truncated": len(out) >= limit}


def _element(dev, key):
    """The data element with this key (as devices.params gives it)."""
    sets = dict(_param_sets(dev))
    prefix = ""
    rest = key
    if key.startswith("c") and "/" in key and key.split("/")[0][1:].isdigit():
        prefix = key.split("/")[0] + "/"
        rest = key[len(prefix):]
    ps = sets.get(prefix)
    if ps is None:
        raise OpError("not_found", "No parameter set '%s' on this device." % (prefix or "device"))
    parts = rest.split("/")
    el = None
    for p in ps:
        if to_text(_safe(lambda: p.identifier, "")) == parts[0]:
            el = p
            break
    if el is None:
        raise OpError("not_found", "No parameter '%s' (device_parameters lists the keys)." % key)
    for part in parts[1:]:
        nxt = None
        for sub in list(el):
            if to_text(_safe(lambda: sub.identifier, "")) == part:
                nxt = sub
                break
        if nxt is None:
            raise OpError("not_found", "No element '%s' in parameter '%s'." % (part, key))
        el = nxt
    return el


def op_devices_configure(args):
    c = Ctx()
    dev = _device(c, args["path"])
    done = []
    errors = []
    for v in args.get("values") or []:
        try:
            el = _element(dev, v["key"])
            val = to_text(v["value"])
            if _safe(lambda: el.is_enumeration, False):
                match = None
                for e in el.allowed_values or []:
                    if val in (to_text(e.identifier), to_text(_safe(lambda: e.visible_name, "")), to_text(_safe(lambda: e.value, ""))):
                        match = e
                        break
                if match is None:
                    raise OpError("bad_value", "'%s' isn't one of %s" % (val, ", ".join(to_text(e.identifier) for e in el.allowed_values)))
                el.enum_value = match
            else:
                el.value = val
            done.append({"key": v["key"], "value": to_text(_safe(lambda: el.value, val))})
        except Exception as e:
            errors.append({"key": v.get("key"), "error": to_text(e)[:200]})
    for m in args.get("mappings") or []:
        try:
            el = _element(dev, m["key"])
            if not _safe(lambda: el.is_mappable_io, False):
                raise OpError("bad_value", "'%s' is not an I/O channel." % m["key"])
            io = el.io_mapping
            io.variable = to_text(m.get("variable") or "")
            if "address" in m:
                io.manual_iec_address = to_text(m["address"]) if m["address"] else None
            done.append({"key": m["key"], "variable": to_text(_safe(lambda: io.variable, "")), "address": to_text(_safe(lambda: io.manual_iec_address, "") or "")})
        except Exception as e:
            errors.append({"key": m.get("key"), "error": to_text(e)[:200]})
    return {"path": c.path_of(dev), "done": done, "errors": errors, "saved": c.save_if(args)}


def _remapped(variable, pairs):
    """variable with the first matching pair's 'from' (a whole name prefix, any case) replaced
    by its 'to', the rest (array index, struct member) kept; None when no pair matches."""
    low = variable.lower()
    for p in pairs:
        f = p["from"]
        if low.startswith(f.lower()):
            rest = variable[len(f):]
            if not rest or not (rest[0].isalnum() or rest[0] == "_"):
                return p["to"] + rest
    return None


def op_devices_remap(args):
    """Rewrites the I/O mapping of every channel in the device tree that is mapped to a renamed
    variable: a channel's mapping is the string io_mapping.variable ('Application.GVL_IO.wFoo[3]').
    pairs: [{from, to}] name prefixes. Leaves the IEC addresses alone."""
    c = Ctx()
    pairs = args.get("pairs") or []
    changed = []

    def walk(dev_path, el):
        if _safe(lambda: el.is_mappable_io, False):
            m = _safe(lambda: el.io_mapping)
            v = to_text(_safe(lambda: m.variable, "") or "") if m is not None else ""
            new = _remapped(v, pairs) if v else None
            if new is not None and new != v:
                m.variable = new
                changed.append({"device": dev_path, "key": to_text(_safe(lambda: el.identifier, "") or ""), "from": v, "to": new})
        if _safe(lambda: el.has_sub_elements, False):
            for sub in list(el):
                walk(dev_path, sub)

    def rec(obj, names):
        for ch in children(obj):
            nm = name_of(ch)
            if _safe(lambda: ch.is_device, False):
                for _prefix, ps in _param_sets(ch):
                    for p in ps:
                        walk("/".join(names + [nm]), p)
                rec(ch, names + [nm])
            elif kind_of(ch, c.app_guid) in ("folder", "other"):
                rec(ch, names + [nm])

    if pairs:
        rec(c.proj, [])
    return {"changed": changed, "saved": c.save_if(args)}


mcp_ops.OPS["devices.params"] = op_devices_params
mcp_ops.OPS["devices.remap"] = mcp_sim._locked(op_devices_remap)
mcp_ops.OPS["devices.configure"] = mcp_sim._locked(op_devices_configure)
mcp_ops.OPS["devices.search"] = op_devices_search
mcp_ops.OPS["devices.add"] = mcp_sim._locked(op_devices_add)
