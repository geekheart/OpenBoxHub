#!/usr/bin/env python3
"""Read STEP with FreeCAD/OpenCascade and compare solids to a fixture manifest.

Usage on macOS with the installed FreeCAD bundle:
  /Applications/FreeCAD.app/Contents/Resources/bin/python \
    scripts/verify-step.py test-results/step-validation/expected.json

The manifest contains cases with a STEP path and expected part bounds/volumes.
This script is optional CAD integration validation, not a browser dependency.
"""

import argparse
import json
import math
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--freecad-lib", type=Path)
    args = parser.parse_args()
    library = args.freecad_lib or Path("/Applications/FreeCAD.app/Contents/Resources/lib")
    if library.is_dir():
        sys.path.insert(0, str(library))
    import FreeCAD  # type: ignore[import-not-found]
    import Part  # type: ignore[import-not-found]

    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("units") != "mm":
        raise ValueError("Expected fixture dimensions must use millimeters")
    report = {"reader": "FreeCAD/OpenCascade", "version": FreeCAD.Version(), "cases": []}
    failures = []
    for case in manifest["cases"]:
        step_path = (manifest_path.parent / case["step"]).resolve()
        expected = case["parts"]
        shape = Part.Shape()
        shape.read(str(step_path))
        solids = shape.Solids
        actual = []
        errors = []
        if shape.isNull():
            errors.append("reader returned a null shape")
        if len(solids) != len(expected):
            errors.append(f"expected {len(expected)} solids, read {len(solids)}")
        for index, solid in enumerate(solids):
            bounds = solid.BoundBox
            dimensions = [bounds.XLength, bounds.YLength, bounds.ZLength]
            actual.append({"index": index, "closed": solid.isClosed(), "valid": solid.isValid(),
                           "volume": solid.Volume, "bounds": dimensions, "faces": len(solid.Faces),
                           "shells": len(solid.Shells)})
            if not solid.isClosed() or not solid.isValid() or solid.Volume <= 0:
                errors.append(f"solid {index} is not a closed, valid, positive-volume solid")

        # STEP readers may reorder independent solids. Match each expected
        # component exactly once by geometric dimensions and volume instead.
        remaining = list(actual)
        matches = []
        for part in expected:
            found = next((solid for solid in remaining if
                          all(math.isclose(a, b, rel_tol=0, abs_tol=0.0001)
                              for a, b in zip(solid["bounds"], part["bounds"])) and
                          math.isclose(solid["volume"], part["volume"],
                                       rel_tol=0.000001, abs_tol=0.001)), None)
            if found is None:
                errors.append(f"no unused solid matches {part['id']} dimensions and volume")
                continue
            remaining.remove(found)
            matches.append({"part": part["id"], "solid": found["index"],
                            "maxDimensionErrorMm": max(abs(a - b) for a, b in
                                                        zip(found["bounds"], part["bounds"])),
                            "volumeErrorMm3": abs(found["volume"] - part["volume"])})
        result = {"name": case["name"], "step": str(step_path), "passed": not errors,
                  "solids": actual, "matches": matches, "errors": errors}
        report["cases"].append(result)
        print(f"{'PASS' if not errors else 'FAIL'} {case['name']}: {len(solids)} solids", flush=True)
        if errors:
            failures.extend(f"{case['name']}: {error}" for error in errors)
    report["passed"] = not failures
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for failure in failures:
        print(failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
