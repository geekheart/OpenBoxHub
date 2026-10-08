import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import App from '../src/App'
import { LanguageProvider } from '../src/Language'
import { diagnostic, languageFromUrl, translate, urlWithLanguage } from '../src/i18n'
import messages from '../src/translations.json'
import { createDesignFile, parseDesignFile } from '../src/design'
import { DEFAULT_PARAMS, defaultGroups, type Params } from '../src/types'
import { validateOverrides, validateParams } from '../src/geometry'

function renderApp(url: string): string {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: url } } })
  try { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(App))) }
  finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('locale links default to Chinese and preserve unrelated URL parameters and hash', () => {
  assert.equal(languageFromUrl('https://example.com/OpenBoxHub/'), 'zh-CN')
  assert.equal(languageFromUrl('https://example.com/OpenBoxHub/?lang=en'), 'en')
  assert.equal(languageFromUrl('https://example.com/OpenBoxHub/?lang=xx'), 'zh-CN')
  const url = 'https://example.com/OpenBoxHub/?design=outer%20box&view=3d#parts'
  const english = urlWithLanguage(url, 'en')
  assert.equal(english, 'https://example.com/OpenBoxHub/?design=outer+box&view=3d&lang=en#parts')
  const chinese = new URL(urlWithLanguage(english, 'zh-CN'))
  assert.equal(chinese.pathname, '/OpenBoxHub/')
  assert.equal(chinese.searchParams.get('design'), 'outer box')
  assert.equal(chinese.searchParams.get('view'), '3d')
  assert.equal(chinese.hash, '#parts')
  assert.equal(chinese.searchParams.has('lang'), false)
})

test('real initial app renders both locales, accessible controls and the required repository link', () => {
  const chinese = renderApp('https://example.com/OpenBoxHub/')
  const english = renderApp('https://example.com/OpenBoxHub/?lang=en')
  assert.match(chinese, /参数设置/)
  assert.match(chinese, /value="zh-CN" selected=""/)
  assert.match(english, /value="en" selected=""/)
  assert.match(english, /aria-label="Interface language"/)
  assert.match(english, /aria-label="Length X"/)
  assert.match(english, /aria-label="Hide Outer box"/)
  assert.match(english, /aria-label="Auto-rotate"/)
  assert.match(english, /Generating model/)
  assert.match(english, /id="github-link"[^>]+href="https:\/\/github.com\/geekheart\/OpenBoxHub"[^>]+target="_blank"[^>]+rel="noopener noreferrer"/)
  assert.match(english, /OpenBoxHub on GitHub \(opens in a new tab\)/)
  assert.doesNotMatch(english.replaceAll('简体中文', ''), /\p{Script=Han}/u)
})

test('translation keeps values literal, including filenames, template characters and JSON keys', () => {
  const filename = '外盒_{1}_$&.step'
  assert.equal(translate('en', '已发起下载：{0}，请在浏览器下载列表中查看', filename), `Download started: ${filename}. Check your browser’s downloads.`)
  assert.equal(diagnostic('en', `已发起下载：${filename}，请在浏览器下载列表中查看`), `Download started: ${filename}. Check your browser’s downloads.`)
  assert.equal(diagnostic('en', '参数 width 必须是有限数字。'), 'Parameter width must be a finite number.')
  assert.equal(diagnostic('en', '独立零件参数包含无效零件：用户自定义值。'), 'Individual parameters reference an invalid part: 用户自定义值.')
  assert.equal(diagnostic('en', 'Unexpected engine error: code 42'), 'Unexpected engine error: code 42')
  assert.equal(diagnostic('en', 'toString'), 'toString')
  assert.equal(translate('en', '__proto__'), '__proto__')
  assert.equal(diagnostic('en', '独立零件参数包含无效零件：外盒。'), 'Individual parameters reference an invalid part: 外盒.')
  for (const [source, target] of Object.entries(messages)) {
    const parameters = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()
    assert.deepEqual(parameters(target), parameters(source), `Interpolation mismatch in ${source}`)
  }
})

test('real geometry validation errors translate without changing the original diagnostics or inputs', () => {
  const patches: Partial<Params>[] = [
    { width: NaN }, { width: 10 }, { height: 500 }, { wall: 0.1 }, { wall: 25 },
    { radius: -1 }, { rows: 13 }, { gap: 5 }, { lidClearance: 5 }, { lidThickness: 0.1 },
    { lidType: 'unsupported' as Params['lidType'] }, { baseStyle: 'unsupported' as Params['baseStyle'] },
    { holeSize: 1 }, { ribWidth: 0.1 }, { holeMargin: 0.1 }, { slotLength: 1 },
    { width: 20, depth: 20, rows: 12, cols: 12 }, { height: 8, lidDepth: 10 },
  ]
  for (const patch of patches) {
    const params = { ...DEFAULT_PARAMS, ...patch }
    const before = structuredClone(params)
    const errors = validateParams(params)
    assert.ok(errors.length > 0)
    const original = errors.join('\n')
    assert.doesNotMatch(diagnostic('en', original), /\p{Script=Han}/u)
    assert.equal(diagnostic('zh-CN', original), original)
    assert.deepEqual(params, before)
  }
  const overrides = { lid: { height: 400, wall: 0.1 }, 'inner:0': { height: 400, bottom: 0.1 } }
  const errors = validateOverrides(DEFAULT_PARAMS, defaultGroups(2, 3), overrides)
  assert.ok(errors.length >= 3)
  assert.doesNotMatch(diagnostic('en', errors.join('\n')), /\p{Script=Han}/u)
})

test('generated part names and nested CAD/motion errors translate at the display boundary', () => {
  assert.equal(diagnostic('en', '内盒 02'), 'Insert 02')
  assert.equal(diagnostic('en', '外套盖'), 'Overlapping lid')
  assert.equal(diagnostic('en', '内盒 02生成失败：CAD 轮廓为空，请检查间隙与壁厚。'), 'Could not generate Insert 02: The CAD profile is empty. Check the clearance and wall thickness.')
  assert.equal(diagnostic('en', '外盒与内盒 02的展示路径相交，请调整零件尺寸。'), 'The animation paths of Outer box and Insert 02 intersect. Adjust the part dimensions.')
  assert.equal(diagnostic('en', '参数文件必须是对象。'), 'Design file must be an object.')
  assert.equal(diagnostic('en', '内盒 02网格精度校验失败。'), 'Mesh precision validation failed for Insert 02.')
})

test('English rendering and diagnostic display do not alter saved designs or JSON field names', async () => {
  const config = { params: { ...DEFAULT_PARAMS, width: 220 }, groups: defaultGroups(2, 3), overrides: { lid: { bottom: 1.8 } }, locked: true }
  const before = await createDesignFile(config).blob.text()
  renderApp('https://example.com/OpenBoxHub/?lang=en')
  const file = createDesignFile(config)
  assert.equal(await file.blob.text(), before)
  assert.equal(file.filename, 'openboxhub_220x140x40.json')
  assert.deepEqual(parseDesignFile(before), config)
  try { parseDesignFile(JSON.stringify({ ...JSON.parse(before), params: { ...config.params, width: 'bad' } })) }
  catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(diagnostic('en', error.message), 'Parameter width must be a finite number.')
    return
  }
  assert.fail('Invalid imported data must still be rejected')
})
