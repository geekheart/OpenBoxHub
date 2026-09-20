import { createExportFile, type ExportFormat } from './export'
import type { ModelData } from './types'

/** File generation stays off the UI thread, including STEP topology validation. */
self.onmessage = async (event: MessageEvent<{ model: ModelData; target: string; format: ExportFormat }>) => {
  try {
    const { model, target, format } = event.data
    self.postMessage({ file: await createExportFile(model, target, format) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '文件生成失败，请重新打开导出窗口。' })
  }
}
