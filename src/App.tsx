import { useEffect, useRef, useState } from 'react'
import { Box, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, FileJson, FolderOpen, Expand, Eye, EyeOff, Grid2X2, Layers, LockKeyhole, Maximize, Merge, Minus, MousePointer2, Package, Plus, RotateCcw, RotateCw, Scan, ShieldCheck, SlidersHorizontal, Split, UnlockKeyhole, X } from 'lucide-react'
import Scene, { INNER_COLORS, type CameraView, type ViewMode } from './Scene'
import { DEFAULT_PARAMS, defaultGroups, partOverrideKey, type ModelData, type Params, type PartDimensions, type PartOverrides } from './types'
import type { ExportFormat } from './export'
import { createDesignFile, parseDesignFile, MAX_DESIGN_FILE_BYTES, type DesignConfig } from './design'
import NumberField from './NumberField'
import PartInspector from './PartInspector'

const fmt = (n: number) => Number(n.toFixed(2)).toString()

function Modal({ title, eyebrow, children, onClose }: { title: string; eyebrow: string; children: React.ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    panel.current?.focus()
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        const focusable = panel.current?.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex="0"]')
        if (!focusable?.length) return
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', listener)
    return () => { document.removeEventListener('keydown', listener); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1} onClick={e => e.stopPropagation()}><button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={20} /></button><div className="eyebrow">{eyebrow}</div><h2>{title}</h2>{children}</div></div>
}

function connected(cells: number[], cols: number) {
  if (!cells.length) return false
  const set = new Set(cells), seen = new Set([cells[0]]), stack = [cells[0]]
  while (stack.length) {
    const n = stack.pop()!
    const neighbors = [n - cols, n + cols, ...(n % cols ? [n - 1] : []), ...(n % cols < cols - 1 ? [n + 1] : [])]
    neighbors.forEach(v => { if (set.has(v) && !seen.has(v)) { seen.add(v); stack.push(v) } })
  }
  return seen.size === set.size
}

export default function App() {
  const [params, setParams] = useState<Params>({ ...DEFAULT_PARAMS })
  const [groups, setGroups] = useState(() => defaultGroups(DEFAULT_PARAMS.rows, DEFAULT_PARAMS.cols))
  const [overrides, setOverrides] = useState<PartOverrides>({})
  const [tab, setTab] = useState<'outer' | 'inner' | 'lid'>('outer')
  const [locked, setLocked] = useState(false)
  const [model, setModel] = useState<ModelData | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [viewError, setViewError] = useState('')
  const [mode, setMode] = useState<ViewMode>('open')
  const [explosion, setExplosion] = useState(70)
  const [visible, setVisible] = useState({ outer: true, inner: true, lid: true })
  const [transparent, setTransparent] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [cameraView, setCameraView] = useState<CameraView>({ name: 'iso', tick: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [modal, setModal] = useState<'export' | 'design' | 'help' | null>(null)
  const [exportTarget, setExportTarget] = useState('plate')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('step')
  const [download, setDownload] = useState<{ href: string; filename: string; target: string; format: ExportFormat; model: ModelData } | null>(null)
  const [exportError, setExportError] = useState('')
  const [designDownload, setDesignDownload] = useState<{ href: string; filename: string; model: ModelData; locked: boolean } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingImport = useRef<{ id: number; config: DesignConfig } | null>(null)
  const appliedImport = useRef<DesignConfig | null>(null)
  const [toast, setToast] = useState('')
  const worker = useRef<Worker | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)

  useEffect(() => {
    const w = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = e => {
      if (e.data.id !== requestId.current) return
      setBusy(false)
      const incoming = pendingImport.current
      if (incoming && incoming.id === e.data.id) {
        pendingImport.current = null; setImporting(false)
        if (e.data.error) { setImportError(e.data.error); return }
        const config = incoming.config
        appliedImport.current = config
        setParams(config.params); setGroups(config.groups); setOverrides(config.overrides); setLocked(config.locked)
        setModel(e.data.model); setError(''); setSelected(null); setSelection([])
        setVisible({ outer: true, inner: true, lid: true }); setMode('open'); setAutoRotate(false)
        setCameraView(v => ({ name: 'iso', tick: v.tick + 1 })); setModal(null); setToast('参数已导入')
        return
      }
      if (e.data.error) setError(e.data.error)
      else { setModel(e.data.model); setError('') }
    }
    w.onerror = () => { setBusy(false); setImporting(false); pendingImport.current = null; setError('建模引擎加载失败，请刷新页面重试。') }
    return () => { w.terminate(); worker.current = null }
  }, [])
  useEffect(() => {
    const imported = appliedImport.current
    if (imported && imported.params === params && imported.groups === groups && imported.overrides === overrides) { appliedImport.current = null; return }
    pendingImport.current = null; setImporting(false)
    setBusy(true); setError('')
    const id = ++requestId.current
    const timer = setTimeout(() => worker.current?.postMessage({ id, params, groups, overrides }), 160)
    return () => clearTimeout(timer)
  }, [params, groups, overrides])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer) }, [toast])
  useEffect(() => {
    if (!fullScreen) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFullScreen(false); if (document.fullscreenElement) void document.exitFullscreen() } }
    const fullscreenChanged = () => { if (!document.fullscreenElement) setFullScreen(false) }
    document.addEventListener('keydown', escape)
    document.addEventListener('fullscreenchange', fullscreenChanged)
    const timer = setTimeout(() => setCameraView(v => ({ ...v, tick: v.tick + 1 })), 80)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', escape); document.removeEventListener('fullscreenchange', fullscreenChanged); clearTimeout(timer) }
  }, [fullScreen])
  function toggleFullScreen() {
    if (fullScreen) { setFullScreen(false); if (document.fullscreenElement) void document.exitFullscreen() }
    else { setFullScreen(true); stage.current?.requestFullscreen?.().catch(() => { /* Window-filling fallback for embedded browsers. */ }) }
  }

  function update<K extends keyof Params>(key: K, value: Params[K]) { setParams(p => ({ ...p, [key]: value })) }
  function updateGrid(rows: number, cols: number) {
    setParams(p => ({ ...p, rows, cols })); setGroups(defaultGroups(rows, cols)); setOverrides(prev => { const next: PartOverrides = {}; if (prev.lid) next.lid = prev.lid; return next }); setSelection([]); setSelected(null)
  }
  function changeGroups(next: number[][]) {
    const keys = new Set(['lid', ...next.map(partOverrideKey)])
    setGroups(next)
    setOverrides(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => keys.has(key))))
  }
  function applyPartValues(values: PartDimensions) {
    if (!chosenPart || busy) return
    if (chosenPart.kind === 'outer') setParams(prev => ({ ...prev, ...values, ...(locked ? { width: prev.width, depth: prev.depth, height: prev.height } : {}) }))
    else if (chosenPart.overrideKey) setOverrides(prev => ({ ...prev, [chosenPart.overrideKey!]: { ...values } }))
  }
  function resetPartValues() {
    if (!chosenPart?.overrideKey) return
    setOverrides(prev => { const next = { ...prev }; delete next[chosenPart.overrideKey!]; return next })
  }
  async function importDesign(file: File) {
    const id = ++requestId.current
    setImportError(''); setImporting(true); setBusy(true)
    try {
      if (file.size > MAX_DESIGN_FILE_BYTES) throw new Error('参数文件不能超过 1 MB。')
      const contents = await file.text()
      if (id !== requestId.current) return
      const config = parseDesignFile(contents)
      if (!worker.current) throw new Error('建模引擎尚未准备好，请稍后重试。')
      pendingImport.current = { id, config }
      worker.current.postMessage({ id, params: config.params, groups: config.groups, overrides: config.overrides })
    } catch (failure) {
      if (id !== requestId.current) return
      pendingImport.current = null; setImporting(false); setBusy(false)
      setImportError(failure instanceof Error ? failure.message : '参数文件读取失败。')
    }
  }
  function closeDesignModal() {
    if (importing) {
      ++requestId.current
      pendingImport.current = null
      setImporting(false); setBusy(false)
    }
    setModal(null)
  }
  function toggleCell(cell: number) {
    const group = groups.find(g => g.includes(cell))!
    const allSelected = group.every(c => selection.includes(c))
    setSelection(allSelected ? selection.filter(c => !group.includes(c)) : [...new Set([...selection, ...group])])
  }
  const selectedGroupCount = groups.filter(g => g.some(c => selection.includes(c))).length
  const canMerge = selectedGroupCount > 1 && connected(selection, params.cols)
  const canSplit = groups.some(g => g.length > 1 && g.some(c => selection.includes(c)))
  function mergeSelection() {
    if (!canMerge) return
    const next = [...groups.filter(g => !g.some(c => selection.includes(c))), [...selection].sort((a, b) => a - b)].sort((a, b) => a[0] - b[0])
    changeGroups(next)
    setSelection([]); setSelected(null)
    setToast('相邻格子已合并为一个独立内盒')
  }
  function splitSelection() {
    changeGroups(groups.flatMap(g => g.some(c => selection.includes(c)) ? g.map(c => [c]) : [g]).sort((a, b) => a[0] - b[0]))
    setSelection([]); setSelected(null)
  }
  function selectPart(id: string | null) {
    if (busy) return
    setSelected(id)
    const part = model?.parts.find(p => p.id === id)
    if (part) setTab(part.kind)
    setSelection(part?.cellIds ?? [])
  }
  useEffect(() => {
    setDownload(null); setExportError('')
    if (modal !== 'export' || !model || busy || error) return
    let cancelled = false
    let href: string | undefined
    const fileWorker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
    fileWorker.onmessage = (event: MessageEvent<{ file?: { blob: Blob; filename: string }; error?: string }>) => {
      if (cancelled) return
      const { file, error: failure } = event.data
      if (failure || !file) setExportError(failure || '文件生成失败，请重新打开导出窗口。')
      else {
        href = URL.createObjectURL(file.blob)
        setDownload({ href, filename: file.filename, target: exportTarget, format: exportFormat, model })
      }
      fileWorker.terminate()
    }
    fileWorker.onerror = () => {
      if (!cancelled) setExportError('导出引擎加载失败，请重新打开导出窗口。')
      fileWorker.terminate()
    }
    fileWorker.postMessage({ model, target: exportTarget, format: exportFormat })
    return () => {
      cancelled = true
      fileWorker.terminate()
      // Let an in-progress browser download acquire the Blob before releasing it.
      if (href) { const url = href; setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    }
  }, [modal, model, busy, error, exportTarget, exportFormat])
  useEffect(() => {
    setDesignDownload(null)
    if (modal !== 'design' || !model || busy || error) return
    const file = createDesignFile({ params: model.params, groups: model.groups, overrides: model.overrides, locked })
    const href = URL.createObjectURL(file.blob)
    setDesignDownload({ href, filename: file.filename, model, locked })
    return () => { setTimeout(() => URL.revokeObjectURL(href), 30_000) }
  }, [modal, model, busy, error, locked])
  const readyDownload = !busy && !error && download?.model === model && download?.target === exportTarget && download?.format === exportFormat ? download : null
  const readyDesignDownload = !busy && !error && designDownload?.model === model && designDownload?.locked === locked ? designDownload : null
  const chosenPart = model?.parts.find(p => p.id === selected)
  const partValues = chosenPart ? chosenPart.kind === 'outer' ? { width: params.width, depth: params.depth, height: params.height, wall: params.wall, bottom: params.bottom } : { ...chosenPart.dimensions, ...overrides[chosenPart.overrideKey ?? ''] } : null
  const field = (key: keyof Params, label: string, options: Partial<React.ComponentProps<typeof NumberField>> = {}) => <NumberField label={label} value={params[key] as number} onChange={v => update(key, v)} {...options} />

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="./" aria-label="OpenBoxHub 首页"><span className="brand-icon"><Box size={24} strokeWidth={1.6} /></span><span>OpenBox<em>Hub</em><span className="brand-sub">参数化收纳盒工坊</span></span></a>
      <div className="header-actions"><button className="text-button design-file-button" aria-label="参数文件" onClick={() => { setImportError(''); setModal('design') }}><FileJson size={16} /><span>参数文件</span></button><button className="icon-button" aria-label="使用帮助" onClick={() => setModal('help')}><CircleHelp size={19} /></button><span className="header-divider" /><button className="primary-button export-main" disabled={!model || busy || !!error} onClick={() => { setExportFormat('step'); setExportTarget('plate'); setModal('export') }}><ArrowDownToLine size={17} />导出 STEP<ChevronDown size={14} /></button></div>
    </header>

    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-heading"><div><div className="eyebrow">PARAMETERS</div><h1>参数设置</h1></div><SlidersHorizontal size={19} /></div>
        <div className="editor-tabs" role="tablist" aria-label="模型参数分类">{([['outer', '外盒', Box], ['inner', '内盒', Grid2X2], ['lid', '盒盖', Layers]] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}</div>
        <div className="sidebar-scroll">
          {tab === 'outer' && <>
            <section className="control-section"><div className="section-title"><h2><span>01</span>外形尺寸</h2><button className={`lock-button ${locked ? 'locked' : ''}`} onClick={() => setLocked(!locked)} title="锁定长宽高后，继续调整内盒与盒盖">{locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}{locked ? '已锁定' : '锁定外形'}</button></div><div className="dimension-fields">{field('width', '长度 X', { disabled: locked, min: 30 })}{field('depth', '宽度 Y', { disabled: locked, min: 30 })}{field('height', '高度 Z', { disabled: locked, min: 12 })}</div></section>
            <section className="control-section"><div className="section-title"><h2><span>02</span>盒体结构</h2></div><div className="two-fields">{field('wall', '侧壁厚度', { min: 0.8, max: 8 })}{field('bottom', '底板厚度', { min: 0.8, max: 8 })}{field('radius', '外角半径', { min: 0, max: 30 })}</div><div className="field-label">底板形式</div><div className="option-pair pattern-options">{([
              ['solid', '完整底板', '通用 · 小物收纳'],
              ['honeycomb', '蜂窝镂空', '六边形孔阵列'],
              ['circles', '圆孔镂空', '规则圆孔阵列'],
              ['grid', '方格镂空', '规则方孔阵列'],
              ['slots', '长圆孔', '横向通风孔阵列'],
            ] as const).map(([type, title, description]) => <button key={type} className={params.baseStyle === type ? 'option-card selected' : 'option-card'} onClick={() => update('baseStyle', type)}><span className={`base-icon ${type}-base`} /><strong>{title}</strong><small>{description}</small>{params.baseStyle === type && <Check size={12} />}</button>)}</div>
            {params.baseStyle !== 'solid' && <div className="perforation-settings"><div className="field-label">镂空参数</div><div className="two-fields">{field('holeSize', params.baseStyle === 'circles' ? '圆孔直径' : params.baseStyle === 'honeycomb' ? '蜂窝对边宽' : params.baseStyle === 'slots' ? '长圆孔宽' : '方孔边长', { min: 2, max: 60, step: 0.5 })}{field('ribWidth', '孔间筋宽', { min: 0.8, max: 20 })}{field('holeMargin', '距内壁留白', { min: 0.8, max: 30 })}{params.baseStyle === 'slots' && field('slotLength', '长圆孔总长', { min: params.holeSize, max: 100, step: 0.5 })}</div><div className="perforation-note"><span className="live-dot" /><span>{busy ? '重新排列孔阵列…' : model && !error ? `${model.metrics.holeCount ?? 0} 个完整通孔` : '等待有效参数'} · 边缘自动保留完整筋条</span></div><button className="perforation-preview" onClick={() => { setVisible({ outer: true, inner: false, lid: false }); setMode('assembly'); setCameraView(v => ({ name: 'top', tick: v.tick + 1 })); setToast('已隐藏内盒和盖子，可直接检查底板镂空') }}><Eye size={13} />单独查看底板<ArrowUpRight size={12} /></button>{model?.warnings.map((warning, i) => <p className="inline-warning" key={i}>{warning}</p>)}</div>}
            </section>
            <div className="next-step"><div><Grid2X2 size={19} /><span><strong>设置内盒布局</strong><small>等分空间，或合并相邻格子</small></span></div><button onClick={() => setTab('inner')} aria-label="设置内盒"><ChevronRight size={18} /></button></div>
          </>}

          {tab === 'inner' && <>
            <section className="control-section"><div className="section-title"><h2><span>01</span>划分空间</h2><span className="mini-badge">{groups.length} 个独立内盒</span></div><p className="section-description">调整行列数会恢复等分布局。</p><div className="grid-counters">{([['cols', '横向列数'], ['rows', '纵向行数']] as const).map(([key, label]) => <div className="counter" key={key}><label>{label}</label><div><button aria-label={`减少${label}`} disabled={params[key] <= 1} onClick={() => updateGrid(key === 'rows' ? params.rows - 1 : params.rows, key === 'cols' ? params.cols - 1 : params.cols)}><Minus size={13} /></button><strong>{params[key]}</strong><button aria-label={`增加${label}`} disabled={params[key] >= 12} onClick={() => updateGrid(key === 'rows' ? params.rows + 1 : params.rows, key === 'cols' ? params.cols + 1 : params.cols)}><Plus size={13} /></button></div></div>)}</div><div className="layout-presets"><span>快速布局</span>{[[2, 3], [3, 4], [1, 1]].map(([r, c]) => <button key={`${r}-${c}`} onClick={() => updateGrid(r, c)}>{c} × {r}</button>)}</div></section>
            <section className="control-section grid-section"><div className="section-title"><h2><span>02</span>自由组合</h2><button className="tiny-button" onClick={() => updateGrid(params.rows, params.cols)}>恢复等分</button></div><p className="section-description">点击选择相邻格子，合并为一个内盒。</p><div className="cell-grid" style={{ gridTemplateColumns: `repeat(${params.cols}, 1fr)`, aspectRatio: `${params.width} / ${params.depth}` }} aria-label="内盒分格编辑器">{Array.from({ length: params.rows * params.cols }, (_, cell) => {
              const gi = groups.findIndex(g => g.includes(cell)), group = groups[gi], sel = selection.includes(cell)
              const right = cell % params.cols < params.cols - 1 && group.includes(cell + 1)
              const bottom = cell < params.cols * (params.rows - 1) && group.includes(cell + params.cols)
              return <button key={cell} aria-label={`第${Math.floor(cell / params.cols) + 1}行第${cell % params.cols + 1}列，内盒${gi + 1}`} aria-pressed={sel} onClick={() => toggleCell(cell)} className={sel ? 'cell selected' : 'cell'} style={{ backgroundColor: sel ? '#b4c4a2' : INNER_COLORS[gi % INNER_COLORS.length], borderRightColor: right ? 'transparent' : '#f9faf5', borderBottomColor: bottom ? 'transparent' : '#f9faf5' }}>{cell === Math.min(...group) && <span>{String(gi + 1).padStart(2, '0')}</span>}{sel && <i />}</button>
            })}</div><div className="grid-caption"><MousePointer2 size={12} /><span>{selection.length ? `已选择 ${selectedGroupCount} 个内盒 · ${selection.length} 个格子` : '支持矩形与 L 形组合'}</span><button disabled={!selection.length} onClick={() => setSelection([])}>清空</button></div><div className="merge-actions"><button disabled={!canMerge} onClick={mergeSelection}><Merge size={15} />合并选中</button><button disabled={!canSplit} onClick={splitSelection}><Split size={15} />拆分</button></div>{selectedGroupCount > 1 && !canMerge && <p className="inline-warning">请选择边与边相连的格子，角接触无法合并。</p>}</section>
            <section className="control-section"><div className="section-title"><h2><span>03</span>内盒与配合</h2></div><div className="two-fields">{field('innerWall', '内盒壁厚', { min: 0.8, max: 5 })}{field('innerBottom', '内盒底厚', { min: 0.8, max: 5 })}{field('gap', '单边间隙', { min: 0.1, max: 2, step: 0.05 })}</div><div className="reference-note wrap">相邻内盒之间留两倍间隙。内盒高度自动预留定位盖装配空间。</div></section>
          </>}

          {tab === 'lid' && <>
            <section className="control-section"><div className="section-title"><h2><span>01</span>选择装配方式</h2></div><div className="lid-options">{([['sleeve', '外套式盒盖', '从外侧套合'], ['inset', '内嵌定位盖', '定位边嵌入内腔'], ['none', '开放式收纳', '不生成盒盖']] as const).map(([type, title, description]) => <button key={type} className={`lid-option ${params.lidType === type ? 'selected' : ''}`} onClick={() => update('lidType', type)}><span className={`lid-diagram ${type}`}><i /><b /></span><span><strong>{title}</strong><small>{description}</small></span><span className="radio-dot">{params.lidType === type && <i />}</span></button>)}</div></section>
            <section className="control-section"><div className="section-title"><h2><span>02</span>装配参数</h2></div><div className="two-fields">{field('lidThickness', '盖板厚度', { disabled: params.lidType === 'none', min: 0.8, max: 8 })}{field('lidDepth', '定位边深度', { min: 1, max: 10 })}{field('lidClearance', '单边配合间隙', { min: 0.1, max: 1.5, step: 0.05 })}</div><div className="fit-note"><ShieldCheck size={18} /><div><strong>打印配合间隙</strong><p>初始单边间隙为 0.25 mm。材料和打印机表现不同，建议先试打确认松紧。</p></div></div><p className="section-description">定位边越深，内盒可用高度越小。</p></section>
          </>}
        </div>
        <div className="sidebar-footer"><span><span className={`status-dot ${busy ? 'busy' : error ? 'error' : ''}`} />{busy ? '正在更新模型' : error ? '请检查参数' : '实体模型已就绪'}</span><button className="tiny-button" onClick={() => { setParams({ ...DEFAULT_PARAMS }); setGroups(defaultGroups(DEFAULT_PARAMS.rows, DEFAULT_PARAMS.cols)); setOverrides({}); setSelection([]); setLocked(false); setSelected(null); setToast('已恢复默认参数与布局') }}><RotateCcw size={12} />重置</button></div>
      </aside>

      <main className="preview-area">
        <div className="preview-heading"><div><span className="eyebrow">3D PREVIEW</span><h2>模型预览</h2></div><div className="view-segments" aria-label="展示模式">{([['assembly', '组合', Box], ['open', '开盖', Layers], ['exploded', '爆炸', Expand]] as const).map(([id, label, Icon]) => <button key={id} onClick={() => setMode(id)} aria-pressed={mode === id} className={mode === id ? 'active' : ''}><Icon size={14} />{label}</button>)}</div></div>
        <div className={`canvas-stage ${fullScreen ? 'is-fullscreen' : ''}`} ref={stage}>
          <Scene model={model} params={model?.params ?? DEFAULT_PARAMS} mode={mode} explosion={explosion} visible={visible} transparent={transparent} selected={selected} onSelect={selectPart} cameraView={cameraView} autoRotate={autoRotate} onError={setViewError} />
          <div className="stage-label"><span className="live-dot" />3D 预览<span className="unit-label">mm</span></div>
          <button className="fullscreen-button" onClick={toggleFullScreen} aria-label={fullScreen ? '退出全屏预览' : '全屏预览'} title={fullScreen ? 'Esc 返回参数编辑' : '铺满整个窗口查看模型'}>{fullScreen ? <X size={16} /> : <Expand size={16} />}<span>{fullScreen ? '返回编辑' : '全屏'}</span>{fullScreen && <kbd>Esc</kbd>}</button>
          {fullScreen && <div className="fullscreen-modes"><div className="fullscreen-brand"><Box size={21} />OpenBoxHub<span>3D 工作台</span></div><div className="view-segments">{([['assembly', '组合', Box], ['open', '开盖', Layers], ['exploded', '爆炸', Expand]] as const).map(([id, label, Icon]) => <button key={id} onClick={() => setMode(id)} aria-pressed={mode === id} className={mode === id ? 'active' : ''}><Icon size={15} />{label}</button>)}</div></div>}
          <div className="parts-panel"><div className="parts-heading"><Layers size={13} /><span>组件</span><span>{model?.parts.length ?? '—'}</span></div>{([['outer', '外盒', '#708671'], ['inner', '内盒', '#d4dcca'], ['lid', '盒盖', '#81947a']] as const).map(([key, label, color]) => <button key={key} disabled={key === 'lid' && params.lidType === 'none'} onClick={() => setVisible(v => ({ ...v, [key]: !v[key] }))} aria-label={`${visible[key] ? '隐藏' : '显示'}${label}`} className={!visible[key] ? 'muted' : ''}><i style={{ background: color }} /><span>{label}</span><small>{key === 'inner' ? `× ${groups.length}` : key === 'lid' && params.lidType === 'none' ? '—' : '× 1'}</small>{visible[key] ? <Eye size={13} /> : <EyeOff size={13} />}</button>)}<label className="part-picker">编辑零件<select aria-label="选择编辑零件" value={selected ?? ''} disabled={busy || !model} onChange={event => selectPart(event.target.value || null)}><option value="">点击模型或选择…</option>{model?.parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label></div>
          <div className="view-toolbar"><button aria-label="恢复透视视角" title="恢复透视视角" onClick={() => setCameraView(v => ({ name: 'iso', tick: v.tick + 1 }))}><Maximize size={17} /></button><button aria-label="俯视图" title="俯视图" onClick={() => setCameraView(v => ({ name: 'top', tick: v.tick + 1 }))}><Grid2X2 size={17} /></button><button aria-label="正视图" title="正视图" onClick={() => setCameraView(v => ({ name: 'front', tick: v.tick + 1 }))}><Box size={17} /></button><span /><button aria-label="透视外盒" title="透视外盒" className={transparent ? 'active' : ''} onClick={() => setTransparent(!transparent)}><Scan size={17} /></button><button aria-label="自动旋转" title="自动旋转" className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate(!autoRotate)}><RotateCw size={17} /></button></div>
          {mode === 'exploded' && <div className="explode-control"><Expand size={15} /><label htmlFor="explosion">展开程度</label><input id="explosion" type="range" min="0" max="100" value={explosion} onChange={e => setExplosion(Number(e.target.value))} /><span>{explosion}%</span></div>}
          {((error && !chosenPart) || viewError) && <div className="model-error" role="alert"><strong>{viewError ? '预览暂不可用' : '这些参数还不能生成盒子'}</strong><p>{error || viewError}</p>{error && <small>预览保留上一次有效模型，修正参数后自动更新。</small>}</div>}
          {busy && <div className="updating-badge"><span className="spinner" />{model ? '更新模型中' : '正在生成模型'}</div>}
          {chosenPart && partValues && <PartInspector part={chosenPart} values={partValues} custom={!!overrides[chosenPart.overrideKey ?? '']} locked={chosenPart.kind === 'outer' && locked} busy={busy} error={error} onApply={applyPartValues} onReset={resetPartValues} onClose={() => setSelected(null)} />}
          <div className="axis-widget" aria-hidden="true"><span className="z">Z</span><span className="y">Y</span><span className="x">X</span><i /><b /><em /></div>
          <div className="canvas-hint"><MousePointer2 size={13} />拖动旋转<span />滚轮缩放<span />右键平移</div>
        </div>

        <div className="summary-strip"><div className="summary-icon"><Package size={22} strokeWidth={1.5} /></div><div className="summary-item"><span>外盒尺寸</span><strong>{fmt(params.width)} <i>×</i> {fmt(params.depth)} <i>×</i> {fmt(params.height)}<small>mm</small></strong></div><div className="summary-item"><span>内部布局</span><strong>{groups.length}<small>个内盒 / {params.cols} × {params.rows} 格</small></strong></div><div className="summary-item"><span>默认内盒高度</span><strong>{model ? fmt(model.metrics.innerHeight) : '—'}<small>mm</small></strong></div><div className="summary-item material-stat"><span>实体体积</span><strong>{model ? fmt(model.metrics.totalVolume / 1000) : '—'}<small>cm³</small></strong></div><div className="summary-status"><span><Check size={13} />{busy ? '更新中' : error ? '待修正' : '毫米建模'}</span><small>STEP / STL · Bambu Studio</small></div></div>
      </main>
    </div>

    {modal === 'export' && model && <Modal eyebrow="STEP / STL / ZIP" title="导出模型" onClose={() => setModal(null)}>
      <div className="export-format" role="group" aria-label="导出格式">
        <button aria-pressed={exportFormat === 'step'} onClick={() => setExportFormat('step')}>STEP <small>默认</small></button>
        <button aria-pressed={exportFormat === 'stl'} onClick={() => setExportFormat('stl')}>STL</button>
      </div>
      <div className="export-choices">
        <button className={exportTarget === 'plate' ? 'selected' : ''} onClick={() => setExportTarget('plate')}><Grid2X2 size={21} /><span><strong>整套零件 · {exportFormat.toUpperCase()}</strong><small>{model.parts.length} 个零件平铺在同一文件中</small></span><span className="radio-dot">{exportTarget === 'plate' && <i />}</span></button>
        <button className={exportTarget === 'kit' ? 'selected' : ''} onClick={() => setExportTarget('kit')}><Package size={21} /><span><strong>逐件打包 · ZIP</strong><small>{model.parts.length} 个独立 {exportFormat.toUpperCase()} + 参数清单</small></span><span className="radio-dot">{exportTarget === 'kit' && <i />}</span></button>
      </div>
      <label className="export-select-label">或单独导出一个零件<select aria-label="选择单独导出的零件" value={exportTarget === 'kit' || exportTarget === 'plate' ? '' : exportTarget} onChange={e => setExportTarget(e.target.value || 'plate')}><option value="">选择零件…</option>{model.parts.map(p => <option key={p.id} value={p.id}>{p.name} · {p.bounds.map(fmt).join(' × ')} mm</option>)}</select></label>
      <div className="export-info"><ShieldCheck size={17} /><p>毫米单位，零件底部平放。导入 Bambu Studio 后按热床尺寸重新排盘。{exportFormat === 'step' && <><br />STEP 为分面实体，保留当前模型精度。</>}</p></div>
      {model.warnings.length > 0 && <div className="export-warnings">{model.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
      <div className="export-footer"><span>{exportTarget === 'plate' || exportTarget === 'kit' ? model.parts.length : 1} 件 · {exportFormat.toUpperCase()}<small>{readyDownload ? readyDownload.filename : '正在生成文件'}</small></span>{readyDownload ? <a className="primary-button" href={readyDownload.href} download={readyDownload.filename} onClick={() => setToast(`已发起下载：${readyDownload.filename}，请在浏览器下载列表中查看`)}><ArrowDownToLine size={17} />下载文件</a> : <button className="primary-button" disabled>{!exportError && <span className="spinner" />}{exportError ? '生成失败' : '准备文件…'}</button>}</div>
      {exportError && <p className="inline-warning" role="alert">{exportError}</p>}
    </Modal>}

    {modal === 'design' && <Modal eyebrow="JSON" title="参数文件" onClose={closeDesignModal}>
      <p className="modal-description">导出当前设计，或导入参数继续编辑。刷新页面会恢复默认设计。</p>
      <div className="design-file-section"><FileJson size={23} /><div><h3>导出参数</h3><p>包含外盒、分组、盒盖与零件独立参数。</p></div>{readyDesignDownload ? <a className="primary-button" href={readyDesignDownload.href} download={readyDesignDownload.filename}><ArrowDownToLine size={15} />下载 JSON</a> : <button className="primary-button" disabled>等待有效模型</button>}</div>
      <div className="design-file-section"><FolderOpen size={23} /><div><h3>导入参数</h3><p>选择参数 JSON 或 ZIP 中的 manifest.json。</p></div><button className="primary-button" disabled={importing || busy} onClick={() => fileInput.current?.click()}>{importing ? '正在校验…' : '选择参数文件'}</button><input ref={fileInput} className="visually-hidden" aria-label="导入参数文件" type="file" accept=".json,application/json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importDesign(file) }} /></div>
      {importError && <p className="import-error" role="alert">{importError}<span>当前设计未改变。</span></p>}
    </Modal>}

    {modal === 'help' && <Modal eyebrow="QUICK START" title="使用指南" onClose={() => setModal(null)}><ol className="help-steps"><li><span>01</span><div><strong>确定外盒</strong><p>设置长、宽、高与壁厚。锁定外形后，继续设计内部空间。</p></div></li><li><span>02</span><div><strong>安排内盒</strong><p>按整数行列等分，再选择相邻格子合并。点击三维模型可单独编辑零件尺寸、壁厚与底厚。</p></div></li><li><span>03</span><div><strong>检查装配</strong><p>选择盒盖，切换组合、开盖、爆炸视图，拖动模型查看。</p></div></li><li><span>04</span><div><strong>导出与保存</strong><p>默认下载 STEP，也可选择 STL 或逐件 ZIP。导入 Bambu Studio 后重新排盘；通过「参数文件」保存 JSON，便于继续编辑。</p></div></li></ol></Modal>}
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>
}
