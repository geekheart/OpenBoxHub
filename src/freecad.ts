import type { CadRecipe } from './cad-types'

/** Only arithmetic on these native parameter properties is accepted in recipes. */
function validExpression(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  const tokens = compact.match(/height|bottom|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/]/g)
  return compact.length > 0 && tokens !== null && tokens.join('') === compact
}

/** A standalone macro creates native editable sketches and Part Design history. */
export function createFreeCADMacro(recipe: CadRecipe): string {
  if (!recipe || !Array.isArray(recipe.parts) || recipe.parts.length === 0)
    throw new Error('FreeCAD 工程需要至少一个零件。')
  const ids = new Set<string>()
  for (const part of recipe.parts) {
    if (typeof part.id !== 'string' || !part.id || ids.has(part.id) || typeof part.name !== 'string')
      throw new Error('FreeCAD 零件标识无效或重复。')
    ids.add(part.id)
    if (!part.dimensions || ['width', 'depth', 'height', 'wall', 'bottom'].some(key => {
      const value = part.dimensions[key as keyof typeof part.dimensions]
      return !Number.isFinite(value) || value <= 0
    }) || !Array.isArray(part.offset) || part.offset.length !== 3 || part.offset.some(value => !Number.isFinite(value)))
      throw new Error('FreeCAD 零件尺寸或位置无效。')
    if (!Array.isArray(part.operations) || !part.operations.length || part.operations[0].kind !== 'add')
      throw new Error('FreeCAD 零件必须从拉伸实体开始。')
    for (const operation of part.operations) {
      if (!['add', 'cut'].includes(operation.kind) || typeof operation.label !== 'string' ||
          typeof operation.profileBrep !== 'string' || !operation.profileBrep.trim() ||
          !Number.isFinite(operation.z) || !Number.isFinite(operation.height) || operation.height <= 0)
        throw new Error('FreeCAD 建模步骤或解析轮廓无效。')
      for (const expression of [operation.zExpression, operation.heightExpression])
        if (expression !== undefined && (typeof expression !== 'string' || !validExpression(expression)))
          throw new Error('FreeCAD 参数表达式只支持 height、bottom 和四则运算。')
    }
  }

  // A JSON string literal is also a safe Python string literal. The second
  // encoding keeps labels and BRep content as data, never executable Python.
  const data = JSON.stringify(JSON.stringify(recipe))
  return `# -*- coding: utf-8 -*-
# OpenBoxHub: editable FreeCAD 1.0+ document.
# Run this macro in FreeCAD, then save the new document as .FCStd.
# Dimensions are in millimeters. No files or existing documents are overwritten.
import json
import math
import re
import FreeCAD as App
import Part
import Sketcher

_openboxhub_recipe = json.loads(${data})


def _openboxhub_expression(expression, parameters):
    # Recipe numbers are millimeters; FreeCAD expressions track physical units.
    # Evaluate the arithmetic as scalar millimeters before restoring the unit,
    # so offsets such as height-bottom+1 and multipliers both remain valid.
    names = {'height': '(' + parameters.Name + '.Height / (1 mm))',
             'bottom': '(' + parameters.Name + '.BottomThickness / (1 mm))'}
    scalar = re.sub(r'\\b(height|bottom)\\b', lambda match: names[match.group(0)], expression)
    return '(' + scalar + ') * (1 mm)'


def _openboxhub_geometry(edge):
    curve = edge.Curve
    first, last = edge.FirstParameter, edge.LastParameter
    if isinstance(curve, Part.Line):
        return Part.LineSegment(edge.valueAt(first), edge.valueAt(last))
    if isinstance(curve, Part.Circle):
        circle = Part.Circle(curve.Center, App.Vector(0, 0, 1), curve.Radius)
        if edge.isClosed():
            return circle
        start, end = edge.valueAt(first), edge.valueAt(last)
        if curve.Axis.z < 0:
            start, end = end, start
        angle_start = math.atan2(start.y - curve.Center.y, start.x - curve.Center.x)
        angle_end = math.atan2(end.y - curve.Center.y, end.x - curve.Center.x)
        while angle_end <= angle_start:
            angle_end += 2 * math.pi
        return Part.ArcOfCircle(circle, angle_start, angle_end)
    if isinstance(curve, Part.Ellipse):
        ellipse = Part.Ellipse(curve.Center, curve.MajorRadius, curve.MinorRadius)
        ellipse.AngleXU = math.atan2(curve.XAxis.y, curve.XAxis.x)
        if edge.isClosed():
            return ellipse
        start, end = edge.valueAt(first), edge.valueAt(last)
        if curve.Axis.z < 0:
            start, end = end, start
        def parameter(point):
            delta = point - ellipse.Center
            return math.atan2(delta.dot(ellipse.YAxis) / ellipse.MinorRadius,
                              delta.dot(ellipse.XAxis) / ellipse.MajorRadius)
        angle_start, angle_end = parameter(start), parameter(end)
        while angle_end <= angle_start:
            angle_end += 2 * math.pi
        return Part.ArcOfEllipse(ellipse, angle_start, angle_end)
    if isinstance(curve, (Part.BSplineCurve, Part.BezierCurve)):
        spline = curve.copy() if isinstance(curve, Part.BSplineCurve) else curve.toBSpline()
        if abs(first - spline.FirstParameter) > 1e-9 or abs(last - spline.LastParameter) > 1e-9:
            spline.segment(first, last)
        return spline
    raise RuntimeError('Unsupported analytic sketch curve: ' + str(type(curve)))


def _openboxhub_profile(body, operation, index):
    shape = Part.Shape()
    shape.importBrepFromString(operation['profileBrep'], False)
    if shape.isNull() or not shape.isValid() or not shape.Faces:
        raise RuntimeError('Invalid analytic profile: ' + operation['label'])
    if shape.BoundBox.ZLength > 1e-6 or abs(shape.BoundBox.ZMin) > 1e-6:
        raise RuntimeError('Sketch profile must lie on the XY plane.')
    sketch = body.newObject('Sketcher::SketchObject', 'Profile_' + str(index))
    sketch.Label = operation['label'] + ' · 草图'
    geometries = []
    endpoints = {}
    for edge in shape.Edges:
        geometry = _openboxhub_geometry(edge)
        geometry_index = len(geometries)
        geometries.append(geometry)
        if not edge.isClosed():
            # Sketcher normalizes arcs to +Z. Use normalized endpoints, not
            # the source edge's order, especially at clockwise concave corners.
            normalized = geometry.toShape()
            for vertex, point in ((1, normalized.valueAt(normalized.FirstParameter)),
                                  (2, normalized.valueAt(normalized.LastParameter))):
                key = (round(point.x, 7), round(point.y, 7))
                endpoints.setdefault(key, []).append((geometry_index, vertex))
    # Batch insertion avoids resolving a dense perforation sketch after every
    # edge/constraint, while retaining native editable geometry and topology.
    sketch.addGeometry(geometries, False)
    constraints = []
    for matches in endpoints.values():
        if len(matches) == 2 and matches[0][0] != matches[1][0]:
            a, b = matches
            constraints.append(Sketcher.Constraint('Coincident', a[0], a[1], b[0], b[1]))
    if constraints:
        sketch.addConstraint(constraints)
    return sketch


def _openboxhub_build(recipe):
    document = App.newDocument('OpenBoxHub')
    document.Label = 'OpenBoxHub'
    document.openTransaction('Create editable OpenBoxHub design')
    bodies = []
    try:
        for part_index, part in enumerate(recipe['parts'], 1):
            parameters = document.addObject('App::VarSet', 'Parameters_' + str(part_index))
            parameters.Label = part['name'] + ' · 参数'
            parameters.addProperty('App::PropertyLength', 'Height', 'Dimensions', '零件总高')
            parameters.addProperty('App::PropertyLength', 'BottomThickness', 'Dimensions', '底板或盖板厚度')
            parameters.Height = part['dimensions']['height']
            parameters.BottomThickness = part['dimensions']['bottom']
            # Parameters stay outside the Body: referencing Body-owned properties
            # from its own Pad/Pocket would create a cyclic shape dependency.
            body = document.addObject('PartDesign::Body', 'Body_' + str(part_index))
            body.Label = part['name']
            body.addProperty('App::PropertyString', 'OpenBoxHubId', 'OpenBoxHub')
            body.OpenBoxHubId = part['id']
            body.setEditorMode('OpenBoxHubId', 1)
            body.Placement.Base = App.Vector(*part['offset'])
            previous = None
            for operation_index, operation in enumerate(part['operations'], 1):
                sketch = _openboxhub_profile(body, operation, operation_index)
                sketch.Placement.Base.z = operation['z']
                if operation.get('zExpression'):
                    sketch.setExpression('Placement.Base.z', _openboxhub_expression(operation['zExpression'], parameters))
                document.recompute()
                feature_type = 'PartDesign::Pad' if operation['kind'] == 'add' else 'PartDesign::Pocket'
                feature = body.newObject(feature_type, 'Pad' if operation['kind'] == 'add' else 'Pocket')
                feature.Label = operation['label']
                feature.Profile = sketch
                feature.Length = operation['height']
                feature.Reversed = operation['kind'] == 'cut'
                if operation.get('heightExpression'):
                    feature.setExpression('Length', _openboxhub_expression(operation['heightExpression'], parameters))
                feature.Refine = True
                document.recompute()
                if feature.Shape.isNull() or not feature.Shape.isValid() or len(feature.Shape.Solids) != 1:
                    raise RuntimeError('Failed modeling step: ' + part['name'] + ' / ' + operation['label'])
                if App.GuiUp:
                    sketch.Visibility = False
                    if previous is not None:
                        previous.Visibility = False
                previous = feature
            body.Tip = previous
            bodies.append(body)
        document.recompute()
        document.commitTransaction()
    except Exception:
        document.abortTransaction()
        App.closeDocument(document.Name)
        raise
    if App.GuiUp:
        import FreeCADGui as Gui
        for body in bodies:
            body.Visibility = True
            body.Tip.Visibility = True
        Gui.activeDocument().activeView().viewAxonometric()
        Gui.activeDocument().activeView().fitAll()
    App.Console.PrintMessage('OpenBoxHub: created editable Bodies, sketches, Pads and Pockets. Save as FCStd to keep the feature history.\\n')
    return document


openboxhub_document = _openboxhub_build(_openboxhub_recipe)
`
}
