import Module from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import { buildModel } from './geometry'
import { createMotionPlan } from './motion'
import type { Params, PartOverrides } from './types'

const ready = Module({ locateFile: () => wasmUrl }).then(module => { module.setup(); return module })
self.onmessage = async (event: MessageEvent<{ id: number; params: Params; groups: number[][]; overrides?: PartOverrides }>) => {
  const { id, params, groups, overrides } = event.data
  try {
    const module = await ready
    const model = buildModel(module, params, groups, overrides)
    model.motion = createMotionPlan(module, model)
    const transfer = model.parts.flatMap(part => [part.positions.buffer, part.indices.buffer])
    self.postMessage({ id, model }, { transfer })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : '模型生成失败，请调整参数后重试。' })
  }
}
