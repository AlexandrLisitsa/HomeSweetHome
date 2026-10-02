#!/usr/bin/env python3
"""Extract the firmware lambdas, compile the unit tests and run them.

    python PowerStation/tools/test_firmware_logic.py

Uses a native g++ when one is on PATH, otherwise the gcc:13 Docker image.
Everything it writes goes to PowerStation/tools/build/ (git-ignored).
Exit status is non-zero when extraction, compilation or any test fails;
tests in a KNOWN_BUG group are reported but never fail the run.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
CXXFLAGS = ["-std=c++17", "-O1", "-g", "-Wall", "-Wno-sign-compare", "-Wno-format",
            "-Wno-unused-variable",
            "-Wno-maybe-uninitialized", "-Ibuild", "-I."]
GCC_IMAGE = "gcc:13"


def main():
    rc = subprocess.call([sys.executable, str(HERE / "extract_lambdas.py")])
    if rc:
        return rc
    compile_cmd = ["g++", *CXXFLAGS, "test_firmware_logic.cpp", "-o", "build/test_firmware_logic"]
    run_cmd = "./build/test_firmware_logic"
    gxx = shutil.which("g++")
    if gxx and os.name != "nt":
        rc = subprocess.call(compile_cmd, cwd=HERE)
        return rc or subprocess.call([run_cmd], cwd=HERE)
    script = " ".join(compile_cmd) + " && " + run_cmd
    cmd = ["docker", "run", "--rm", "-v", f"{PROJECT}:/src", "-w", "/src/tools", GCC_IMAGE, "sh", "-c", script]
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    return subprocess.call(cmd, env=env)


if __name__ == "__main__":
    sys.exit(main())
