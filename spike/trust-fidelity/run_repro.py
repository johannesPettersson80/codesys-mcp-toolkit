"""Run truST `check` (or `build`) on minimal repro cases.

Each case is a folder under repros/ holding .st files (and optionally a
config.st). The case is copied with trust-template/ (CODESYS profile, simulated
I/O, web/discovery off) into a fresh temp project, so nothing is ever deleted.

usage: python -I run_repro.py <trust-runtime.exe> [case ...] [--build]
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def run(exe, case, cmd):
    proj = tempfile.mkdtemp(prefix=f"trust-{case}-")
    for name in os.listdir(os.path.join(HERE, "trust-template")):
        if name in ("simulation.toml",):
            continue
        s = os.path.join(HERE, "trust-template", name)
        if os.path.isdir(s):
            shutil.copytree(s, os.path.join(proj, name), dirs_exist_ok=True)
        else:
            shutil.copy(s, proj)
    os.remove(os.path.join(proj, "src", "config.st"))
    for f in os.listdir(os.path.join(HERE, "repros", case)):
        shutil.copy(os.path.join(HERE, "repros", case, f), os.path.join(proj, "src", f))
    r = subprocess.run([exe, cmd, "--project", proj], capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout + r.stderr).strip()
    lines = [l for l in out.splitlines() if "expected VAR_GLOBAL, PROGRAM" not in l]
    print(f"== {case}: exit {r.returncode}")
    print("\n".join(lines[:15]) or "(no output)")


if __name__ == "__main__":
    exe = sys.argv[1]
    cmd = "build" if "--build" in sys.argv else "check"
    cases = [a for a in sys.argv[2:] if not a.startswith("--")] or sorted(os.listdir(os.path.join(HERE, "repros")))
    for c in cases:
        run(exe, c, cmd)
