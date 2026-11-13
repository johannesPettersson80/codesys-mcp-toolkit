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


FS_RETRY_S = 3.0


def retry_fs(fn, *args):
    """Run a file operation, retrying while Windows reports the file as in use.

    On Windows, replacing or removing a file fails with "access denied" (WinError 5,
    or IOException in .NET) while another process holds it open: the server polling
    heartbeat.json, an antivirus scan, the search indexer. That lasts milliseconds,
    so retry for up to FS_RETRY_S before giving up and raising the last error.
    """
    deadline = time.time() + FS_RETRY_S
    delay = 0.005
    while True:
        try:
            return fn(*args)
        except Exception:
            if time.time() + delay > deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.1)


_TMP_SEQ = [0]


def _write_text_net(path, data):
    """Write with .NET (IronPython only): the handle is closed when this returns."""
    import System.IO
    import System.Text
    System.IO.File.WriteAllText(path, data, System.Text.UTF8Encoding(False))


def write_json_atomic(path, obj):
    data = to_text(json.dumps(obj, ensure_ascii=False, indent=None, separators=(",", ":")))
    # A fresh temp name each time: inside a Machine Expert window the process has been seen
    # holding on to a temp file (no delete sharing), so renaming that one name failed for good.
    _TMP_SEQ[0] += 1
    tmp = "%s.%d.tmp" % (path, _TMP_SEQ[0])
    try:
        try:
            _write_text_net(tmp, data)
        except ImportError:
            f = retry_fs(codecs.open, tmp, "w", "utf-8")
            try:
                f.write(data)
            finally:
                f.close()
        retry_fs(_replace, tmp, path)
    except Exception as first:
        # Last resort: write the target itself (not atomic; readers retry on a bad read).
        try:
            os.remove(tmp)
        except Exception:
            pass
        try:
            import System.IO  # noqa: F401 (IronPython only)
        except ImportError:
            raise first
        _write_text_net(path, data)


def remove_file(path):
    retry_fs(os.remove, path)


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
