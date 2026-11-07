# -*- coding: utf-8 -*-
# Python 2.7 (IronPython, inside CODESYS) / Python 3 (tests) compatibility.
# Keep this file ASCII-only.
from __future__ import print_function

import codecs
import json
import os
import sys
import time

PY2 = sys.version_info[0] == 2

if PY2:
    text_type = unicode  # noqa: F821
    string_types = (str, unicode)  # noqa: F821
else:
    text_type = str
    string_types = (str,)


def to_text(value):
    """Best-effort conversion of anything (including .NET strings/enums) to text."""
    if value is None:
        return None
    if isinstance(value, text_type):
        return value
    if PY2 and isinstance(value, str):
        for enc in ("utf-8", "mbcs", "latin-1"):
            try:
                return value.decode(enc)
            except Exception:
                continue
    try:
        return text_type(value)
    except Exception:
        return repr(value)


def read_json(path):
    f = codecs.open(path, "r", "utf-8-sig")
    try:
        return json.loads(f.read())
    finally:
        f.close()


def _replace(src, dst):
    if hasattr(os, "replace"):
        os.replace(src, dst)
        return
    try:
        import System.IO  # IronPython
        if System.IO.File.Exists(dst):
            System.IO.File.Replace(src, dst, None)
        else:
            System.IO.File.Move(src, dst)
        return
    except ImportError:
        pass
    if os.path.exists(dst):
        os.remove(dst)
    os.rename(src, dst)


def write_json_atomic(path, obj):
    tmp = path + ".tmp"
    data = json.dumps(obj, ensure_ascii=False, indent=None, separators=(",", ":"))
    f = codecs.open(tmp, "w", "utf-8")
    try:
        f.write(to_text(data))
    finally:
        f.close()
    _replace(tmp, path)


def current_pid():
    try:
        import System.Diagnostics  # IronPython
        return int(System.Diagnostics.Process.GetCurrentProcess().Id)
    except ImportError:
        return os.getpid()


def pid_alive(pid):
    if not pid:
        return True
    try:
        import System.Diagnostics  # IronPython
        try:
            p = System.Diagnostics.Process.GetProcessById(int(pid))
            return not p.HasExited
        except Exception:
            return False
    except ImportError:
        pass
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def now():
    return time.time()
