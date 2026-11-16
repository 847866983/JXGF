import { useEffect, useState } from 'react'
import { BookOpen, Check, Plus, RefreshCw, Save } from 'lucide-react'
import type { MemoryEntry } from '@shared/memory'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'

export default function Memory(): React.JSX.Element {
  const project = useApp((s) => s.project)

  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [appendText, setAppendText] = useState('')
  const [loading, setLoading] = useState(false)

  const selected = entries.find((e) => e.key === selectedKey) ?? null

  const loadList = (): void => {
    void window.api.memoryList().then((list) => {
      setEntries(list)
      setSelectedKey((prev) => prev ?? list[0]?.key ?? null)
    })
  }

  useEffect(() => {
    if (project) loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  useEffect(() => {
    if (!selectedKey) return
    void window.api.memoryRead(selectedKey).then((text) => {
      setContent(text)
      setDirty(false)
    })
  }, [selectedKey])

  if (!project) {
    return (
      <div>
        <PageHeader title="记忆库" desc="项目的长期记忆：世界观、角色、风格、连续性、决策日志" />
        <div className="px-8 pb-8">
          <EmptyState title="请先在仪表盘打开一个项目" />
        </div>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    if (!selectedKey) return
    setLoading(true)
    try {
      await window.api.memoryWrite(selectedKey, content)
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
      loadList()
    } finally {
      setLoading(false)
    }
  }

  const append = async (): Promise<void> => {
    if (!selectedKey || !appendText.trim()) return
    setLoading(true)
    try {
      await window.api.memoryAppend(selectedKey, appendText.trim())
      setAppendText('')
      const text = await window.api.memoryRead(selectedKey)
      setContent(text)
      loadList()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="记忆库"
        desc="项目的长期记忆，存在本地项目文件夹里，换电脑 / 换 AI 都不丢"
        actions={
          <button className="btn-ghost" onClick={loadList}>
            <RefreshCw size={15} />
            刷新
          </button>
        }
      />

      <div className="grid grid-cols-[240px_1fr] items-start gap-4 px-8 pb-8">
        {/* 左：记忆文件列表 */}
        <div className="panel p-2">
          {entries.map((e) => (
            <button
              key={e.key}
              onClick={() => {
                if (dirty && !window.confirm('当前内容未保存，切换会丢失，确定切换？')) return
                setSelectedKey(e.key)
              }}
              className={`flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors ${
                selectedKey === e.key
                  ? 'bg-accent-600/15 text-accent-400'
                  : 'text-slate-300 hover:bg-white/[0.05]'
              }`}
            >
              <BookOpen size={15} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{e.label}</span>
                  {!e.exists && <span className="shrink-0 text-[10px] text-slate-600">空</span>}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-slate-500">{e.hint}</div>
              </div>
            </button>
          ))}
        </div>

        {/* 右：编辑器 */}
        <div className="panel p-4">
          {!selected ? (
            <EmptyState title="选择左侧的一类记忆开始编辑" />
          ) : (
            <div className="flex h-full flex-col">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">{selected.label}</div>
                  <div className="text-[11px] text-slate-500">
                    {selected.file}
                    {selected.updatedAt ? ` · 更新于 ${new Date(selected.updatedAt).toLocaleString()}` : ' · 尚未创建'}
                    {dirty ? ' · 未保存' : ''}
                  </div>
                </div>
                {!selected.appendOnly && (
                  <button className="btn-primary" disabled={loading} onClick={() => void save()}>
                    {saved ? <Check size={15} /> : <Save size={15} />}
                    {saved ? '已保存' : '保存'}
                  </button>
                )}
              </div>

              {selected.appendOnly ? (
                // 决策日志：只追加
                <>
                  <div className="mb-2 flex gap-2">
                    <textarea
                      className="field min-h-[72px] flex-1 resize-y"
                      placeholder="记录一条决策，例如：陈放的发色确定为纯黑，第 1-3 集统一。"
                      value={appendText}
                      onChange={(e) => setAppendText(e.target.value)}
                    />
                    <button
                      className="btn-primary self-start"
                      disabled={loading || !appendText.trim()}
                      onClick={() => void append()}
                    >
                      <Plus size={15} />
                      追加
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto rounded-lg bg-ink-950/50 p-3">
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-300">
                      {content || '（还没有决策记录）'}
                    </pre>
                  </div>
                </>
              ) : (
                <textarea
                  className="field min-h-[420px] flex-1 resize-y font-mono text-[13px] leading-relaxed"
                  placeholder={`在这里写下${selected.label}，AI 下次会读这里来"记住"你的项目。`}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value)
                    setDirty(true)
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
