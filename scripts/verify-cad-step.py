#!/usr/bin/env python3
"""Independently read analytic STEP solids and perform real CAD edits in FreeCAD.

macOS example (FreeCAD is a validation tool, not an application dependency):
  /Applications/FreeCAD.app/Contents/Resources/bin/python \
    scripts/verify-cad-step.py test-results/cad-validation/expected.json \
    --report test-results/cad-validation/freecad-report.json

Manifest: {"units":"mm","cases":[{"name":"default","step":"box.step",
  "parts":[{"id":"outer","bounds":[200,150,40],"volume":12345,
    "maxFaces":24,"minCylinderFaces":4,"maxTriangleFaces":0}]}]}

Volume is optional; prefer an analytic reference. Polygonal preview volume may
be an independent approximate reference with an explicit relative tolerance.
Per-part dimensionToleranceMm (default 1e-4), volumeToleranceMm3
(default 1e-3), and volumeRelativeTolerance (default 1e-6) may be specified.
Every solid must be closed and valid; triangle-only planar facets are rejected
by default. Surface types, face counts, and successful face extrusion, fusion,
and subtraction are recorded. No imported file is modified or overwritten.
"""

import argparse
from collections import Counter
import json
import math
import sys
from pathlib import Path


def inspect_solid(solid, Part):
    bounds = solid.BoundBox
    surfaces = Counter(type(face.Surface).__name__ for face in solid.Faces)
    triangles = sum(isinstance(face.Surface, Part.Plane) and len(face.Wires) == 1
                    and len(face.OuterWire.Edges) == 3
                    and all(isinstance(edge.Curve, Part.Line) for edge in face.OuterWire.Edges)
                    for face in solid.Faces)
    return {"bounds": [bounds.XLength, bounds.YLength, bounds.ZLength],
            "min": [bounds.XMin, bounds.YMin, bounds.ZMin],
            "max": [bounds.XMax, bounds.YMax, bounds.ZMax],
            "volume": solid.Volume, "closed": solid.isClosed(), "valid": solid.isValid(),
            "faces": len(solid.Faces), "edges": len(solid.Edges), "shells": len(solid.Shells),
            "surfaces": dict(surfaces), "linearTriangleFaces": triangles}


def edit_solid(solid, Part):
    planes = [(index, face) for index, face in enumerate(solid.Faces)
              if isinstance(face.Surface, Part.Plane)]
    if not planes:
        raise ValueError("box solid has no editable planar face")
    index, face = max(planes, key=lambda item: item[1].Area)
    u0, u1, v0, v1 = face.ParameterRange
    normal = face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
    depth = 0.2
    addition = face.extrude(normal * depth)
    cutter = face.extrude(normal * -depth)
    fused = solid.fuse(addition)
    cut = solid.cut(cutter)
    result = {"faceIndex": index, "faceAreaMm2": face.Area, "depthMm": depth,
              "extrusion": {"valid": addition.isValid(), "closed": addition.isClosed(),
                            "solids": len(addition.Solids), "volume": addition.Volume},
              "fusion": {"valid": fused.isValid(), "solids": len(fused.Solids),
                         "volume": fused.Volume, "volumeChange": fused.Volume - solid.Volume},
              "subtraction": {"valid": cut.isValid(), "solids": len(cut.Solids),
                              "volume": cut.Volume, "volumeChange": solid.Volume - cut.Volume}}
    if (not addition.isValid() or not addition.isClosed() or len(addition.Solids) != 1
            or not fused.isValid() or len(fused.Solids) != 1
            or not cut.isValid() or len(cut.Solids) != 1
            or fused.Volume <= solid.Volume + 1e-5
            or cut.Volume >= solid.Volume - 1e-5 or cut.Volume <= 0):
        raise ValueError(f"planar face cannot be reliably extruded/fused/cut: {result}")
    return result


def matches(actual, expected):
    dimensions_match = all(math.isclose(a, b, rel_tol=0,
        abs_tol=expected.get("heightToleranceMm", 0.0001) if axis == 2
        else expected.get("dimensionToleranceMm", 0.0001))
        for axis, (a, b) in enumerate(zip(actual["bounds"], expected["bounds"])))
    volume_match = ("volume" not in expected or math.isclose(actual["volume"], expected["volume"],
                    rel_tol=expected.get("volumeRelativeTolerance", 0.000001),
                    abs_tol=expected.get("volumeToleranceMm3", 0.001)))
    offset = expected.get("offset")
    placement_match = offset is None or all(math.isclose(a, b, rel_tol=0,
        abs_tol=expected.get("heightToleranceMm", 0.0001) if axis == 2
        else expected.get("dimensionToleranceMm", 0.0001)) for axis, (a, b) in enumerate(zip(
            [(actual["min"][0] + actual["max"][0]) / 2,
             (actual["min"][1] + actual["max"][1]) / 2, actual["min"][2]], offset)))
    return dimensions_match and volume_match and placement_match


def main():
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
        raise ValueError("Expected CAD dimensions must use millimeters")
    report = {"reader": "FreeCAD/OpenCascade", "version": FreeCAD.Version(), "cases": []}
    for case in manifest["cases"]:
        result = {"name": case["name"], "step": str((manifest_path.parent / case["step"]).resolve()),
                  "solids": [], "matches": [], "errors": []}
        errors = result["errors"]
        try:
            shape = Part.Shape()
            shape.read(result["step"])
            solids = shape.Solids
            if shape.isNull() or not shape.isValid():
                errors.append("STEP reader returned a null or invalid shape")
            if len(solids) != len(case["parts"]):
                errors.append(f"expected {len(case['parts'])} solids, read {len(solids)}")
            if len(shape.Faces) != sum(len(solid.Faces) for solid in solids):
                errors.append("STEP contains faces outside the expected solid bodies")
            for index, solid in enumerate(solids):
                stats = {"index": index, **inspect_solid(solid, Part)}
                result["solids"].append(stats)
                if not stats["valid"] or not stats["closed"] or stats["volume"] <= 0:
                    errors.append(f"solid {index} is not closed, valid, and positive-volume")
                try:
                    stats["editing"] = edit_solid(solid, Part)
                except Exception as error:
                    errors.append(f"solid {index}: {error}")
            if case.get("flat"):
                for index, solid in enumerate(result["solids"]):
                    for other in result["solids"][index + 1:]:
                        if all(min(solid["max"][axis], other["max"][axis]) >
                               max(solid["min"][axis], other["min"][axis]) + 1e-6
                               for axis in (0, 1)):
                            errors.append(f"flat solids {index} and {other['index']} overlap in XY")
            remaining = list(result["solids"])
            for expected in case["parts"]:
                actual = next((candidate for candidate in remaining if matches(candidate, expected)), None)
                if actual is None:
                    errors.append(f"no unused solid matches {expected['id']} dimensions/volume")
                    continue
                remaining.remove(actual)
                if actual["linearTriangleFaces"] > expected.get("maxTriangleFaces", 0):
                    errors.append(f"{expected['id']} contains {actual['linearTriangleFaces']} planar triangle facets")
                if "maxFaces" in expected and actual["faces"] > expected["maxFaces"]:
                    errors.append(f"{expected['id']} has {actual['faces']} faces; expected at most {expected['maxFaces']}")
                if actual["surfaces"].get("Cylinder", 0) < expected.get("minCylinderFaces", 0):
                    errors.append(f"{expected['id']} lacks the expected analytic cylindrical faces")
                match = {"part": expected["id"], "solid": actual["index"],
                         "maxDimensionErrorMm": max(abs(a - b) for a, b in zip(actual["bounds"], expected["bounds"]))}
                if "volume" in expected:
                    match["volumeErrorMm3"] = abs(actual["volume"] - expected["volume"])
                result["matches"].append(match)
        except Exception as error:
            errors.append(str(error))
        result["passed"] = not errors
        report["cases"].append(result)
        print(f"{'PASS' if result['passed'] else 'FAIL'} {case['name']}: {len(result['solids'])} solids", flush=True)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
    report["passed"] = all(case["passed"] for case in report["cases"])
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
