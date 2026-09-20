import { useEffect, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import NumberField from './NumberField'
import type { PartData, PartDimensions } from './types'

export default function PartInspector({ part, values, custom, locked, busy, error, onApply, onReset, onClose }: {
  part: PartData; values: PartDimensions; custom: boolean; locked: boolean; busy: boolean; error: string
  onApply: (values: PartDimensions) => void; onReset: () => void; onClose: () => void
}) {
  const [draft, setDraft] = useState<PartDimensions>(values)
  useEffect(() => setDraft({ ...values }), [part.id, values.width, values.depth, values.height, values.wall, values.bottom])
  const field = (key: keyof PartDimensions, label: string, min: number) => <NumberField label={label} value={draft[key]} min={min} disabled={locked && ['width', 'depth', 'height'].includes(key)} onChange={value => setDraft(p => ({ ...p, [key]: value }))} />
  return <section className="part-inspector" aria-label="零件参数">
    <div className="inspector-heading"><div><span className="eyebrow">选中零件</span><h3>{part.name}</h3></div><button className="icon-button" aria-label="取消选择" onClick={onClose}><X size={17} /></button></div>
    <p className="inspector-subtitle">{part.isRectangular === false ? '外接矩形尺寸' : '外形尺寸'}{custom && <span>已单独设置</span>}</p>
    <form noValidate onSubmit={event => { event.preventDefault(); onApply(draft) }}>
      <div className="two-fields">
        {field('width', '零件长度 X', part.kind === 'outer' ? 20 : 0.8)}
        {field('depth', '零件宽度 Y', part.kind === 'outer' ? 20 : 0.8)}
        {field('height', '零件高度 Z', part.kind === 'outer' ? 8 : 1)}
        {field('wall', '零件壁厚', part.kind === 'inner' ? 0.6 : 0.8)}
        {field('bottom', part.kind === 'lid' ? '零件盖板厚度' : '零件底厚', part.kind === 'inner' ? 0.6 : 0.8)}
      </div>
      {locked && <p className="inspector-note">外形已锁定，可在外盒面板解锁。</p>}
      {part.kind === 'lid' && <p className="inspector-note">高度包含盖板与定位边。</p>}
      {error && <p className="inspector-error" role="alert">{error}</p>}
      <div className="inspector-actions">{part.kind !== 'outer' && <button className="tiny-button" type="button" disabled={!custom || busy} onClick={onReset}><RotateCcw size={12} />恢复自动</button>}<button className="primary-button" type="submit" disabled={busy}>{busy ? '更新中…' : '应用修改'}</button></div>
    </form>
  </section>
}
