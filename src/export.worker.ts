import { createExportFile, type ExportFormat } from './export'
import { initCAD } from './cad'
import cadWasmUrl from 'replicad-opencascadejs/wasm?url'
import type { ModelData } from './types'

/** CAD building and file generation stay off the UI thread. STL does not load CAD WASM. */
self.onmessage = async (event: MessageEvent<{ model: ModelData; target: string; format: ExportFormat }>) => {
  try {
    const { model, target, format } = event.data
    if (format !== 'stl') await initCAD(cadWasmUrl)
    self.postMessage({ file: await createExportFile(model, target, format) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '文件生成失败，请重新打开导出窗口。' })
  }
}
