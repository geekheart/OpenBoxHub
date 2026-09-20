import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFreeCADMacro } from '../src/freecad'
import type { CadRecipe } from '../src/cad-types'

function recipe(): CadRecipe {
  return { parts: [{ id: 'outer', name: '外盒', kind: 'outer',
    dimensions: { width: 200, depth: 140, height: 40, wall: 2, bottom: 2 }, offset: [100, 70, 0],
    operations: [{ kind: 'add', label: '外轮廓拉伸', profileBrep: 'DBRep_DrawableShape\nCASCADE Topology V3\n', z: 0, height: 40, heightExpression: 'height' },
      { kind: 'cut', label: '挖空', profileBrep: 'DBRep_DrawableShape\nCASCADE Topology V3\n', z: 2, height: 38,
        zExpression: 'bottom', heightExpression: 'height-bottom' }] }] }
}

test('FreeCAD macro encodes analytic profiles and labels as data without losing dimensions or recipes', () => {
  const source = recipe()
  source.parts[0].name = '盒子 "quotes" \\ newline\n__import__("os").system("not executable")'
  source.parts[0].operations[0].profileBrep += '"\'\\unicode 中文\n'
  const macro = createFreeCADMacro(source)
  const encoded = macro.match(/^_openboxhub_recipe = json\.loads\((.*)\)$/m)![1]
  assert.deepEqual(JSON.parse(JSON.parse(encoded)), source)
  assert.match(macro, /PartDesign::Body/)
  assert.match(macro, /Sketcher::SketchObject/)
  assert.match(macro, /PartDesign::Pad/)
  assert.match(macro, /PartDesign::Pocket/)
  assert.match(macro, /App::VarSet/)
  assert.doesNotMatch(macro, /import Mesh|saveAs\(|Part::Feature['"]/)
})

test('FreeCAD recipes reject missing construction history, invalid dimensions and executable expressions', () => {
  assert.throws(() => createFreeCADMacro({ parts: [] }), /至少一个/)
  for (const mutate of [
    (value: CadRecipe) => { value.parts.push(value.parts[0]) },
    (value: CadRecipe) => { value.parts[0].dimensions.height = NaN },
    (value: CadRecipe) => { value.parts[0].offset[0] = Infinity },
    (value: CadRecipe) => { value.parts[0].operations = [] },
    (value: CadRecipe) => { value.parts[0].operations[0].kind = 'cut' },
    (value: CadRecipe) => { value.parts[0].operations[0].profileBrep = '' },
    (value: CadRecipe) => { value.parts[0].operations[0].height = 0 },
    (value: CadRecipe) => { value.parts[0].operations[0].heightExpression = '__import__("os")' },
    (value: CadRecipe) => { value.parts[0].operations[0].heightExpression = 'height; 1' },
  ]) {
    const value = recipe(); mutate(value)
    assert.throws(() => createFreeCADMacro(value))
  }
  const value = recipe()
  value.parts[0].operations[1].heightExpression = '(height - bottom) * 1.0 + 1e-3'
  assert.doesNotThrow(() => createFreeCADMacro(value))
})

// Optional independent native-reader regression. In particular the L fixture
// exercises clockwise concave arcs, and overshooting cavities/circular holes
// exercise unit-aware expressions such as height-bottom+1 and bottom+2.
const fixtureDirectory = process.env.OPENBOXHUB_FREECAD_FIXTURES
const freecadPython = process.env.OPENBOXHUB_FREECAD_PYTHON
test('native FreeCAD preserves analytic sketches and editable features after saving and reopening', {
  skip: !fixtureDirectory || !freecadPython,
  timeout: 600_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'openboxhub-native-freecad-'))
  try {
    const names = readdirSync(fixtureDirectory!).filter(name => name.endsWith('.recipe.json'))
      .map(name => name.slice(0, -'.recipe.json'.length))
      .filter(name => existsSync(join(fixtureDirectory!, name + '.step')))
    assert.ok(names.length > 0, 'native reader verification requires matching recipe and STEP fixtures')
    for (const name of names) {
      const source = JSON.parse(readFileSync(join(fixtureDirectory!, name + '.recipe.json'), 'utf8')) as CadRecipe
      writeFileSync(join(directory, name + '.FCMacro'), createFreeCADMacro(source))
      writeFileSync(join(directory, name + '.recipe.json'), JSON.stringify(source))
      copyFileSync(join(fixtureDirectory!, name + '.step'), join(directory, name + '.step'))
    }
    const reportPath = process.env.OPENBOXHUB_FREECAD_REPORT ?? join(directory, 'report.json')
    execFileSync(freecadPython!, ['scripts/verify-freecad.py', directory, '--report', reportPath], {
      encoding: 'utf8', timeout: 590_000, maxBuffer: 8 * 1024 * 1024,
    })
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.passed, true)
    assert.equal(report.cases.length, names.length)
    for (const result of report.cases) {
      assert.equal(result.passed, true, result.name)
      assert.equal(result.parameterEdits.length, result.bodies.length)
      assert.equal(result.reopenedEdits.length, result.bodies.length)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
