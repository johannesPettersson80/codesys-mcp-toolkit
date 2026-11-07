"""Spike: compose a truST project from a CODESYS export (export.json from
cds_spike.py). One file per top-level ST object; methods, properties and
actions nested into their FB/program; GVLs wrapped in NAMESPACE; interfaces
with their method prototypes. Writes a line map (mirror line -> CODESYS
object + part + line). Python 3, stdlib only. Not v2 code.

usage: python -I compose_mirror.py export.json out_dir
"""
import json, os, re, sys

POU, METHOD, PROP, ACCESSOR, ACTION = "6f9dac99", "f8a58466", "5a3b8626", "792f2eb6", "8ac092e5"
DUT, GVL, ITF, ITF_METHOD, ITF_PROP = "2db5746d", "ffbfa93a", "6654496c", "f89f7675", "5a3b8627"
SKIP = {"ae1de277", "98a2708a", "413e2a7d", "adb5cb65"}  # task config, task, task call, library manager


def kind(o):
    return o["type"][:8].lower()


def header_keyword(decl):
    for line in decl.splitlines():
        s = line.strip()
        if not s or s.startswith("//") or s.startswith("{") or s.startswith("(*"):
            continue
        return s.split()[0].upper()
    return ""


def strip_empty_var(decl):
    return "" if re.fullmatch(r"\s*VAR\s*END_VAR\s*", decl or "") else (decl or "")


class Out:
    def __init__(self):
        self.lines, self.map = [], []

    def add(self, text, src=None, part=None):
        if text is None:
            return
        for i, l in enumerate(text.splitlines()):
            self.lines.append(l)
            self.map.append({"obj": src, "part": part, "line": i + 1} if src else None)

    def raw(self, line):
        self.lines.append(line)
        self.map.append(None)


def main(export, out_dir):
    data = json.load(open(export, encoding="utf-8"))
    objs = data["objects"]
    app_prefix = os.path.commonprefix([o["path"] for o in objs]).rsplit("/", 1)[0]
    by_parent = {}
    for o in objs:
        parent = o["path"].rsplit("/", 1)[0]
        by_parent.setdefault(parent, []).append(o)

    src_dir = os.path.join(out_dir, "src")
    os.makedirs(src_dir, exist_ok=True)
    report, line_map = [], {}

    def rel(o):
        return o["path"][len(app_prefix) + 1:]

    def children(o, k):
        return [c for c in by_parent.get(o["path"], []) if kind(c) == k]

    for o in by_parent.get(app_prefix, []):
        k = kind(o)
        if k in SKIP or o.get("is_folder"):
            continue
        out = Out()
        name = o["name"]
        if k == POU:
            kw = header_keyword(o.get("decl", ""))
            end = {"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION"}.get(kw)
            if not end:
                report.append(f"UNSUPPORTED {name}: header {kw!r}")
                continue
            out.add(o.get("decl", ""), rel(o), "decl")
            out.add(o.get("impl", ""), rel(o), "impl")
            for m in children(o, METHOD):
                out.raw("")
                out.add(m.get("decl", ""), rel(m), "decl")
                out.add(m.get("impl", ""), rel(m), "impl")
                out.raw("END_METHOD")
            for p in children(o, PROP):
                out.raw("")
                pdecl = p.get("decl", "").strip()
                # CODESYS: "PROPERTY [PUBLIC] X : T"  ->  truST: "[PUBLIC] PROPERTY X : T"
                mm = re.match(r"PROPERTY\s+(PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+(.*)", pdecl, re.I)
                pdecl = f"{mm.group(1)} PROPERTY {mm.group(2)}" if mm else pdecl
                out.add(pdecl, rel(p), "decl")
                accs = {a["name"].upper(): a for a in by_parent.get(p["path"], []) if kind(a) == ACCESSOR}
                for acc in ("GET", "SET"):
                    a = accs.get(acc)
                    if not a:
                        continue
                    out.raw(f"    {acc}")
                    out.add(strip_empty_var(a.get("decl", "")), rel(a), "decl")
                    out.add(a.get("impl", ""), rel(a), "impl")
                    out.raw(f"    END_{acc}")
                out.raw("END_PROPERTY")
            for a in children(o, ACTION):
                out.raw("")
                out.raw(f"ACTION {a['name']}:")
                out.add(a.get("impl", ""), rel(a), "impl")
                out.raw("END_ACTION")
            out.raw(end)
        elif k == ITF:
            # CODESYS adds an implicit base interface that truST doesn't know
            idecl = re.sub(r"\s+EXTENDS\s+__System\.IQueryInterface\b", "", o.get("decl", ""))
            idecl = re.sub(r"(EXTENDS\s+)__System\.IQueryInterface\s*,\s*", r"\1", idecl)
            out.add(idecl, rel(o), "decl")
            for m in children(o, ITF_METHOD):
                out.add(m.get("decl", ""), rel(m), "decl")
                out.raw("END_METHOD")
            out.raw("END_INTERFACE")
        elif k == DUT:
            out.add(o.get("decl", ""), rel(o), "decl")
        elif k == GVL:
            out.raw(f"NAMESPACE {name}")
            out.add(o.get("decl", ""), rel(o), "decl")
            out.raw("END_NAMESPACE")
        else:
            report.append(f"UNKNOWN type {o['type']} for {name}")
            continue
        fn = f"{name}.st"
        with open(os.path.join(src_dir, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(out.lines) + "\n")
        line_map[f"src/{fn}"] = out.map
        report.append(f"wrote src/{fn} ({len(out.lines)} lines)")

    with open(os.path.join(out_dir, "mirror-map.json"), "w", encoding="utf-8") as f:
        json.dump(line_map, f, indent=0)
    print("\n".join(report))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
