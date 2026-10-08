import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { diagnostic, languageFromUrl, languages, translate, urlWithLanguage, type Language } from './i18n'

const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void }>({ language: 'zh-CN', setLanguage: () => {} })

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(() => languageFromUrl(window.location.href))
  const setLanguage = useCallback((next: Language) => {
    history.replaceState(history.state, '', urlWithLanguage(window.location.href, next))
    updateLanguage(next)
  }, [])
  useEffect(() => {
    const onPopState = () => updateLanguage(languageFromUrl(window.location.href))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  useEffect(() => {
    document.documentElement.lang = language
    document.title = `OpenBoxHub — ${translate(language, '参数化收纳盒工坊')}`
    document.querySelector('meta[name="description"]')?.setAttribute('content', language === 'en'
      ? 'Design parametric storage boxes in your browser. Arrange inserts, inspect assemblies, and export STEP, STL or editable FreeCAD macros.'
      : '浏览器里的参数化收纳盒工坊。设置尺寸、组合内盒、检查装配，导出 STEP、STL 或可编辑 FreeCAD 宏。')
  }, [language])
  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>
}

export function useTranslation() {
  const { language } = useContext(LanguageContext)
  const t = useCallback((message: string, ...values: (string | number)[]) => translate(language, message, ...values), [language])
  const d = useCallback((message: string) => diagnostic(language, message), [language])
  return { language, t, d }
}

export function LanguageSelect() {
  const { language, setLanguage } = useContext(LanguageContext)
  return <select id="language-select" className="language-select" aria-label={language === 'en' ? 'Interface language' : '界面语言'} value={language} onChange={event => setLanguage(event.currentTarget.value === 'en' ? 'en' : 'zh-CN')}>
    {languages.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}

export function GitHubLink() {
  const { language } = useContext(LanguageContext)
  const label = language === 'en' ? 'OpenBoxHub on GitHub (opens in a new tab)' : '在 GitHub 查看 OpenBoxHub（在新标签页打开）'
  return <a id="github-link" className="icon-button github-link" href="https://github.com/geekheart/OpenBoxHub" target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.71.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1.01 1.73 2.65 1.23 3.3.94.1-.73.4-1.23.71-1.51-2.51-.29-5.15-1.25-5.15-5.56 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.32-2.64 5.27-5.16 5.55.41.35.77 1.03.77 2.08v3.11c0 .3.21.65.78.54A11.25 11.25 0 0 0 12 .75Z" /></svg>
  </a>
}
