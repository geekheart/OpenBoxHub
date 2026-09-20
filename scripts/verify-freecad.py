#!/usr/bin/env python3
"""Execute generated macros and verify native FreeCAD modeling history.

Each fixture consists of NAME.recipe.json, NAME.FCMacro and NAME.step generated
from the same current CAD recipe. Run only trusted project-generated macros.

macOS example (FreeCAD is a validation tool, not a browser dependency):
  /Applications/FreeCAD.app/Contents/Resources/bin/python \
    scripts/verify-freecad.py /tmp/openboxhub-cad \
    --cases default ring L circles --report /tmp/freecad-report.json \
    --save-directory /tmp/openboxhub-fcstd

Every Body must retain native Sketcher and Pad/Pocket features, match the STEP
dimensions and volume, and preserve each profile's area and hole topology.
Height and bottom thickness are edited independently, then the pristine FCStd
is reopened and edited again. Inputs are not modified; optional FCStd outputs
contain the original parameter values. No existing document is overwritten.
"""

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path


def check(condition, message):
    if not condition:
        raise ValueError(message)


def dimensions(shape):
    box = shape.BoundBox
    return [box.XLength, box.YLength, box.ZLength]


def valid_solid(shape, context):
    check(not shape.isNull() and shape.isValid() and shape.isClosed()
          and len(shape.Solids) == 1 and shape.Volume > 0,
          context + ": expected one closed, valid solid")


def edit_parameters(document, recipe, height_delta, bottom_delta):
    results = []
    for index, part in enumerate(recipe["parts"], 1):
        body = document.getObject("Body_" + str(index))
        parameters = document.getObject("Parameters_" + str(index))
        check(parameters.TypeId == "App::VarSet", part["id"] + ": missing native parameters")
        before_height = body.Tip.Shape.BoundBox.ZLength
        parameters.Height = parameters.Height.Value + height_delta
        document.recompute()
        valid_solid(body.Tip.Shape, part["id"] + " after height edit")
        check(math.isclose(body.Tip.Shape.BoundBox.ZLength,
                           before_height + height_delta, abs_tol=1e-4),
              part["id"] + ": Height did not update the feature history")
        volume_after_height = body.Tip.Shape.Volume
        parameters.BottomThickness = parameters.BottomThickness.Value + bottom_delta
        document.recompute()
        valid_solid(body.Tip.Shape, part["id"] + " after bottom edit")
        check(body.Tip.Shape.Volume > volume_after_height + 1e-4,
              part["id"] + ": BottomThickness did not increase material volume")
        check(math.isclose(body.Tip.Shape.BoundBox.ZLength,
                           before_height + height_delta, abs_tol=1e-4),
              part["id"] + ": editing bottom thickness unexpectedly changed total height")
        results.append({"id": part["id"], "heightDeltaMm": height_delta,
                        "bottomDeltaMm": bottom_delta,
                        "bottomEditVolumeChangeMm3": body.Tip.Shape.Volume - volume_after_height})
    return results


def inspect_case(root, name, output, App, Part):
    recipe = json.loads((root / (name + ".recipe.json")).read_text(encoding="utf-8"))
    macro = root / (name + ".FCMacro")
    namespace = {}
    document = None
    try:
        exec(compile(macro.read_text(encoding="utf-8"), str(macro), "exec"), namespace)
        document = namespace["openboxhub_document"]
        step = Part.Shape()
        step.read(str(root / (name + ".step")))
        remaining = list(enumerate(step.Solids))
        bodies = [obj for obj in document.Objects if obj.TypeId == "PartDesign::Body"]
        check(len(bodies) == len(recipe["parts"]) == len(remaining), "body/STEP solid count mismatch")
        result = {"name": name, "stepSolidCount": len(remaining), "bodies": []}
        for body, part in zip(bodies, recipe["parts"]):
            solid = body.Tip.Shape
            valid_solid(solid, part["id"])
            check(body.OpenBoxHubId == part["id"] and body.Label == part["name"],
                  part["id"] + ": native body identity changed")
            offset = list(body.Placement.Base)
            check(all(abs(actual - expected) < 1e-7 for actual, expected in zip(offset, part["offset"])),
                  part["id"] + ": native body placement changed")
            bounds = dimensions(solid)
            match = next(((index, candidate) for index, candidate in remaining
                          if abs(candidate.Volume - solid.Volume) < 0.001
                          and all(abs(a - b) < 0.0001 for a, b in zip(dimensions(candidate), bounds))), None)
            check(match is not None, part["id"] + ": no unused STEP solid matches dimensions/volume")
            remaining.remove(match)
            sketches = [obj for obj in body.Group if obj.TypeId == "Sketcher::SketchObject"]
            features = [obj for obj in body.Group if obj.TypeId in ("PartDesign::Pad", "PartDesign::Pocket")]
            check(len(sketches) == len(features) == len(part["operations"]),
                  part["id"] + ": native modeling history is incomplete")
            profiles = []
            for sketch, feature, operation in zip(sketches, features, part["operations"]):
                expected_type = "PartDesign::Pad" if operation["kind"] == "add" else "PartDesign::Pocket"
                linked_profile = feature.Profile[0] if isinstance(feature.Profile, tuple) else feature.Profile
                check(feature.TypeId == expected_type and linked_profile == sketch,
                      part["id"] + ": incorrect native feature/profile link")
                valid_solid(feature.Shape, part["id"] + " / " + operation["label"])
                expected = Part.Shape()
                expected.importBrepFromString(operation["profileBrep"], False)
                face = Part.makeFace(sketch.Shape.Wires, "Part::FaceMakerBullseye")
                check(abs(face.Area - expected.Area) < 0.001,
                      part["id"] + " / " + operation["label"] + ": sketch area changed")
                check(len(sketch.Shape.Wires) == len(expected.Wires),
                      part["id"] + " / " + operation["label"] + ": sketch hole topology changed")
                profiles.append({"label": operation["label"], "wires": len(sketch.Shape.Wires),
                                 "areaErrorMm2": abs(face.Area - expected.Area),
                                 "geometryTypes": sorted({type(g).__name__ for g in sketch.Geometry})})
            result["bodies"].append({"id": part["id"], "bounds": bounds, "offset": offset, "volume": solid.Volume,
                                     "stepSolidIndex": match[0], "stepVolumeErrorMm3": abs(match[1].Volume - solid.Volume),
                                     "profiles": profiles, "valid": True})
        filename = output / (name + ".FCStd")
        check(not filename.exists(), "refusing to overwrite " + str(filename))
        document.saveAs(str(filename))
        result["parameterEdits"] = edit_parameters(document, recipe, 0.5, 0.1)
        App.closeDocument(document.Name)
        document = App.openDocument(str(filename))
        for index, part in enumerate(recipe["parts"], 1):
            parameters = document.getObject("Parameters_" + str(index))
            check(math.isclose(parameters.Height.Value, part["dimensions"]["height"], abs_tol=1e-8)
                  and math.isclose(parameters.BottomThickness.Value, part["dimensions"]["bottom"], abs_tol=1e-8),
                  part["id"] + ": saved document did not preserve original parameters")
        result["reopenedEdits"] = edit_parameters(document, recipe, 0.75, 0.15)
        result["fcstdBytes"] = filename.stat().st_size
        result["passed"] = True
        return result
    finally:
        if document is not None and document.Name in App.listDocuments():
            App.closeDocument(document.Name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--save-directory", type=Path)
    parser.add_argument("--freecad-lib", type=Path)
    args = parser.parse_args()
    library = args.freecad_lib or Path("/Applications/FreeCAD.app/Contents/Resources/lib")
    if library.is_dir():
        sys.path.insert(0, str(library))
    import FreeCAD as App  # type: ignore[import-not-found]
    import Part  # type: ignore[import-not-found]

    names = args.cases or sorted(path.name.removesuffix(".recipe.json")
                                 for path in args.fixtures.glob("*.recipe.json"))
    check(bool(names), "No recipe fixtures found")
    report = {"reader": "FreeCAD", "version": App.Version(), "complete": False, "cases": []}
    with tempfile.TemporaryDirectory(prefix="openboxhub-freecad-") as temporary:
        output = args.save_directory or Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        for name in names:
            try:
                result = inspect_case(args.fixtures, name, output, App, Part)
                print(f"PASS {name}: {len(result['bodies'])} native Bodies, STEP match, profile topology, edits and saved/reopened edits", flush=True)
            except Exception as error:
                result = {"name": name, "passed": False, "error": str(error)}
                print(f"FAIL {name}: {error}", file=sys.stderr, flush=True)
            report["cases"].append(result)
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report["passed"] = all(case["passed"] for case in report["cases"])
    report["complete"] = True
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
