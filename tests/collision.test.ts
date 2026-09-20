import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d'
import { createCollisionWorld } from '../src/collision'
import { buildModel } from '../src/geometry'
import { DEFAULT_PARAMS } from '../src/types'
import type { PartData, Vec3 } from '../src/types'

const module: ManifoldToplevel = await Module()
module.setup()
const zero = (parts: PartData[]): Vec3[] => parts.map(() => [0, 0, 0])
function fixture(solid: Manifold, id: string): PartData {
  const mesh = solid.getMesh(), bounds = solid.boundingBox()
  const dimensions = bounds.max.map((value, axis) => value - bounds.min[axis]) as Vec3
  return { id, name: id, kind: 'inner', positions: new Float32Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts), assemblyPosition: [0, 0, 0], bounds: dimensions,
    dimensions: { width: dimensions[0], depth: dimensions[1], height: dimensions[2], wall: 1, bottom: 1 },
    isRectangular: true, volume: solid.volume() }
}

test('real box cavities, concave inserts and every lid assemble without false bounding-box collisions', () => {
  for (const lidType of ['none', 'sleeve', 'inset'] as const) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, lidType }, [[0, 1, 3], [2], [4], [5]])
    const world = createCollisionWorld(module, model.parts)
    try { assert.equal(world.firstCollision(zero(model.parts), zero(model.parts)), null) }
    finally { world.dispose() }
  }
})

test('continuous checks catch a large horizontal jump through a wall even when both endpoints are clear', () => {
  const model = buildModel(module, { ...DEFAULT_PARAMS, lidType: 'none', rows: 1, cols: 1 })
  const world = createCollisionWorld(module, model.parts)
  const start = zero(model.parts), finish = zero(model.parts)
  finish[1][0] = DEFAULT_PARAMS.width * 2
  try {
    assert.equal(world.firstCollision(start, start), null)
    assert.equal(world.firstCollision(finish, finish), null)
    assert.deepEqual(world.firstCollision(start, finish), { a: 0, b: 1 })
    assert.deepEqual(world.firstCollision(finish, start), { a: 0, b: 1 })
    const raised = zero(model.parts)
    raised[1][2] = DEFAULT_PARAMS.height + 5
    const spread = raised.map(offset => [...offset] as Vec3)
    spread[1][0] = finish[1][0]
    assert.equal(world.firstCollision(start, raised), null)
    assert.equal(world.firstCollision(raised, spread), null)
  } finally { world.dispose() }
})

test('lifting the cover before the inserts is required by actual vertical sweep collision checks', () => {
  for (const lidType of ['sleeve', 'inset'] as const) {
    const model = buildModel(module, { ...DEFAULT_PARAMS, lidType, rows: 1, cols: 1 })
    const world = createCollisionWorld(module, model.parts)
    const start = zero(model.parts), insertsUp = zero(model.parts)
    insertsUp[1][2] = DEFAULT_PARAMS.height + 5
    try {
      assert.deepEqual(world.firstCollision(start, insertsUp), { a: 1, b: 2 })
      const lidUp = zero(model.parts)
      lidUp[2][2] = DEFAULT_PARAMS.height * 3
      assert.equal(world.firstCollision(start, lidUp), null)
      const bothUp = lidUp.map(offset => [...offset] as Vec3)
      bothUp[1][2] = insertsUp[1][2]
      assert.equal(world.firstCollision(lidUp, bothUp), null)
      assert.equal(world.firstCollision(bothUp, lidUp), null)
      assert.equal(world.firstCollision(lidUp, start), null)
    } finally { world.dispose() }
  }
})

test('ring sweeps preserve their hole and detect a center box crossing the surrounding wall', () => {
  const resources: (CrossSection | Manifold)[] = []
  const keep = <T extends CrossSection | Manifold>(value: T): T => { resources.push(value); return value }
  try {
    const outside = keep(module.CrossSection.square([60, 60], true))
    const hole = keep(module.CrossSection.square([40, 40], true))
    const ringSection = keep(outside.subtract(hole))
    const ring = keep(ringSection.extrude(8))
    const centerSection = keep(module.CrossSection.square([4, 4], true))
    const center = keep(centerSection.extrude(8))
    const parts = [fixture(ring, 'ring'), fixture(center, 'center')]
    const world = createCollisionWorld(module, parts)
    try {
      assert.equal(world.firstCollision(zero(parts), [[5, 0, 0], [0, 0, 0]]), null)
      assert.deepEqual(world.firstCollision(zero(parts), [[50, 0, 0], [0, 0, 0]]), { a: 0, b: 1 })
      // Equal translation is no relative motion, including a shared diagonal.
      assert.equal(world.firstCollision(zero(parts), [[50, 20, 30], [50, 20, 30]]), null)
    } finally { world.dispose() }
  } finally { for (let i = resources.length - 1; i >= 0; i--) resources[i].delete() }
})

test('radial expansion of actual merged ring inserts detects interference after safe vertical extraction', () => {
  const groups = [[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15], [5], [6], [9], [10]]
  const model = buildModel(module, { ...DEFAULT_PARAMS, rows: 4, cols: 4, lidType: 'none' }, groups)
  const world = createCollisionWorld(module, model.parts)
  const start = zero(model.parts)
  const raised = model.parts.map(part => [0, 0, part.kind === 'inner' ? DEFAULT_PARAMS.height + 5 : 0] as Vec3)
  const spread = model.parts.map((part, i) => [part.assemblyPosition[0] * 0.75,
    part.assemblyPosition[1] * 0.75, raised[i][2]] as Vec3)
  try {
    assert.equal(world.firstCollision(start, raised), null)
    assert.deepEqual(world.firstCollision(raised, spread), { a: 1, b: 2 })
  } finally { world.dispose() }
})

test('L-shaped sweeps retain the open quadrant rather than using the convex hull', () => {
  const resources: (CrossSection | Manifold)[] = []
  const keep = <T extends CrossSection | Manifold>(value: T): T => { resources.push(value); return value }
  try {
    const vertical = keep(module.CrossSection.square([4, 30]))
    const horizontal = keep(module.CrossSection.square([30, 4]))
    const lSection = keep(vertical.add(horizontal))
    const lSolid = keep(lSection.extrude(8))
    const square = keep(module.CrossSection.square([3, 3]))
    const shifted = keep(square.translate([10, 10]))
    const cube = keep(shifted.extrude(8))
    const parts = [fixture(lSolid, 'L'), fixture(cube, 'small')]
    const world = createCollisionWorld(module, parts)
    try {
      assert.equal(world.firstCollision(zero(parts), [[2, 2, 0], [0, 0, 0]]), null)
      assert.deepEqual(world.firstCollision(zero(parts), [[12, 0, 0], [0, 0, 0]]), { a: 0, b: 1 })
    } finally { world.dispose() }
  } finally { for (let i = resources.length - 1; i >= 0; i--) resources[i].delete() }
})

test('unsupported mixed-axis paths and released worlds fail explicitly', () => {
  const model = buildModel(module, DEFAULT_PARAMS)
  const world = createCollisionWorld(module, model.parts)
  const finish = zero(model.parts)
  finish[1] = [5, 5, 40]
  assert.throws(() => world.firstCollision(zero(model.parts), finish), /竖直运动与水平运动/)
  assert.throws(() => world.firstCollision([], []), /位移/)
  world.dispose(); world.dispose()
  assert.throws(() => world.firstCollision(zero(model.parts), zero(model.parts)), /已释放/)
})
