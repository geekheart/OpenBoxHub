#!/usr/bin/env python3
"""Compatibility entry point for the analytic CAD STEP verifier.

Run scripts/generate-step-fixtures.ts to generate current fixtures, then pass
their expected.json here or to scripts/verify-cad-step.py. Both entry points
use the same real FreeCAD readback, curve, solid and editing checks.
"""

from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("verify-cad-step.py")), run_name="__main__")
