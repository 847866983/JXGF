import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * 带引用高亮的提示词输入框。
 *
 * textarea 本身不能给局部文字上色，所以用「叠层」做法：
 *   底层 div 渲染带 <mark> 的富文本，上层 textarea 文字透明、只留光标，
 *   两层字体/行高/内边距完全一致并同步滚动 —— 看起来就是"textarea 里的字被高亮了"。
 *
 * 高亮对象：
 *   · @图片N / @视频N / @音频N / @视频音频N / @first / @last
 *   · 当前分镜引用的资产名（角色名）
 */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRegex(names: string[]): RegExp {
  const parts = ['@(?:图片|视频|音频)\\d+', '@视频音频\\d+', '@(?:first|last)']
  for (const n of names) {
    const t = n.trim()
    if (t.length >= 1) parts.unshift(escapeRe(t))
  }
  return new RegExp(`(${parts.join('|')})`, 'g')
}

export interface PromptEditorProps {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  names: string[]
  placeholder?: string
  className?: string
  minHeight?: number
}

export function PromptEditor({
  value,
  onChange,
  onBlur,
  names,
  placeholder,
  className = '',
  minHeight = 150
}: PromptEditorProps): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)

  const re = useMemo(() => buildRegex(names), [names.join('|')])

  // 把文本切成 [普通, 命中, 普通, ...]
  const parts = useMemo(() => {
    const out: { text: string; hit: boolean }[] = []
    let last = 0
    const r = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = r.exec(value))) {
      if (m.index > last) out.push({ text: value.slice(last, m.index), hit: false })
      out.push({ text: m[0], hit: true })
      last = m.index + m[0].length
      if (m[0].length === 0) r.lastIndex += 1
    }
    if (last < value.length) out.push({ text: value.slice(last), hit: false })
    return out
  }, [value, re])

  // 滚动同步
  const syncScroll = (): void => {
    const ta = taRef.current
    const ov = overlayRef.current
    if (!ta || !ov) return
    ov.scrollTop = ta.scrollTop
    ov.scrollLeft = ta.scrollLeft
  }
  useLayoutEffect(syncScroll, [value])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const fn = (): void => syncScroll()
    ta.addEventListener('scroll', fn)
    return () => ta.removeEventListener('scroll', fn)
  }, [])

  const shared =
    'w-full resize-y font-mono text-xs leading-relaxed whitespace-pre-wrap break-words p-2 box-border'

  return (
    <div className={`relative ${className}`} style={{ minHeight }}>
      {/* 底层：高亮富文本 */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        className={`${shared} pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-slate-200`}
        style={{ minHeight }}
      >
        {value.length === 0 ? (
          <span className="text-slate-600">{placeholder}</span>
        ) : (
          parts.map((p, i) =>
            p.hit ? (
              <mark key={i} className="rounded bg-accent-600/40 px-0.5 text-accent-200">
                {p.text}
              </mark>
            ) : (
              <span key={i}>{p.text}</span>
            )
          )
        )}
        {/* 末尾换行占位，保证行数一致 */}
        {'\n'}
      </div>

      {/* 上层：真正的输入框，文字透明只留光标 */}
      <textarea
        ref={taRef}
        className={`${shared} relative rounded-lg border border-white/10 bg-transparent text-transparent focus:border-accent-500/60 focus:outline-none`}
        style={{ minHeight, caretColor: focused ? '#a97bff' : 'transparent' }}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          onBlur?.()
        }}
        onChange={(e) => {
          onChange(e.target.value)
          requestAnimationFrame(syncScroll)
        }}
        onScroll={syncScroll}
        spellCheck={false}
      />
    </div>
  )
}
