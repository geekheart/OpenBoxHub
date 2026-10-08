import messages from './translations.json'

export type Language = 'zh-CN' | 'en'
const english: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), messages))
export const languages = [{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }] as const

export function languageFromUrl(url: string): Language {
  try { return new URL(url, 'https://openboxhub.invalid').searchParams.get('lang') === 'en' ? 'en' : 'zh-CN' }
  catch { return 'zh-CN' }
}

export function urlWithLanguage(url: string, language: Language): string {
  const next = new URL(url)
  if (language === 'en') next.searchParams.set('lang', 'en')
  else next.searchParams.delete('lang')
  return next.href
}

/** Translation arguments remain data: never run them through the message catalog. */
export function translate(language: Language, message: string, ...values: (string | number)[]): string {
  const key = message.trim()
  const template = language === 'en' && english[key] ? message.replace(key, english[key]) : message
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => values[Number(index)] === undefined ? placeholder : String(values[Number(index)]))
}

// Workers and design files retain their canonical messages and part names. Translate only
// known application diagnostics at the UI boundary; do not mutate model data or JSON keys.
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const diagnosticTemplates = Object.keys(english).filter(key => /\{\d+\}/.test(key)).sort((a, b) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length).map(key => {
  const fragments = key.split(/(\{\d+\})/)
  const indices: number[] = []
  const pattern = fragments.map(fragment => {
    const match = /^\{(\d+)\}$/.exec(fragment)
    if (!match) return escapeRegex(fragment)
    indices.push(Number(match[1])); return '(.+?)'
  }).join('')
  return { key, indices, pattern: new RegExp(`^${pattern}$`, 's') }
})

const nameTemplates = new Set([
  '{0}的 CAD 实体无效，请调整尺寸。', '{0}必须为单个闭合 CAD 实体。', '{0}没有建模步骤。',
  '{0}的 CAD 高度或打印底面与设计不一致。', '{0}无法建立碰撞实体。', '{0}必须是对象。',
  '{0}包含不支持的字段。', '未生成 {0} 的 CAD 实体。', '{0}被壁厚或圆角完全占用，请调整参数。',
  '{0}出现断开区域，请降低壁厚、间隙或圆角半径。', '{0}生成失败：{1}', '{0}网格精度校验失败。',
  '{0}与{1}无法通过分层安全展开，请调整零件尺寸。', '{0}与{1}的展示路径相交，请调整零件尺寸。',
])

function translatedName(language: Language, value: string): string {
  if (language !== 'en') return value
  if (/^内盒 \d+(?: 外轮廓| 内腔)?$/.test(value)) {
    const match = /^内盒 (\d+)(.*)$/.exec(value)!
    return `Insert ${match[1]}${match[2] === ' 外轮廓' ? ' outer profile' : match[2] === ' 内腔' ? ' cavity' : ''}`
  }
  const names = ['外盒', '盒盖', '外盒内腔', '外套盖内腔', '盒盖定位裙边', '盒盖定位裙边内腔', '外套盖', '内嵌定位盖', '参数文件', '参数', '独立盒子参数']
  return names.includes(value) ? translate(language, value) : value
}

export function diagnostic(language: Language, message: string, depth = 0): string {
  if (language !== 'en' || !message || depth > 5) return message
  if (message.includes('\n')) return message.split('\n').map(line => diagnostic(language, line, depth)).join('\n')
  if (english[message]) return english[message]
  for (const { key, indices, pattern } of diagnosticTemplates) {
    const match = pattern.exec(message)
    if (!match) continue
    const values: string[] = []
    indices.forEach((index, position) => {
      const value = match[position + 1]
      // Only nested engine failures and generated part names are translated. A filename,
      // parameter key or arbitrary imported value must remain byte-for-byte unchanged.
      values[index] = key === '{0}生成失败：{1}' && index === 1
        ? diagnostic(language, value, depth + 1) : nameTemplates.has(key) ? translatedName(language, value) : value
    })
    return translate(language, key, ...values)
  }
  return translatedName(language, message)
}
