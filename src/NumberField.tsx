import { useEffect, useState } from 'react'

const display = (value: number) => String(Number(value.toFixed(3)))

export default function NumberField({ label, value, onChange, min = 0.1, max = 500, step = 0.1, disabled = false, hint }: {
  label: string; value: number; onChange: (value: number) => void
  min?: number; max?: number; step?: number; disabled?: boolean; hint?: string
}) {
  const [text, setText] = useState(display(value))
  useEffect(() => setText(display(value)), [value])
  function commit() {
    const next = Number(text)
    if (text.trim() === '' || !Number.isFinite(next)) setText(display(value))
    // Preserve exact generated dimensions when a rounded display was not edited.
    else if (next !== Number(display(value))) onChange(next)
  }
  return <label className={`number-field ${disabled ? 'disabled' : ''}`}><span>{label}</span><div><input aria-label={label} type="number" value={text} min={min} max={max} step={step} disabled={disabled} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} /><span>mm</span></div>{hint && <small>{hint}</small>}</label>
}
