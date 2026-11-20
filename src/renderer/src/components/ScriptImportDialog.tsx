import { useRef, useState } from 'react'
import { Check, FileText, Loader2, Sparkles, Upload } from 'lucide-react'
import { Modal } from './Modal'

/**
 * 从剧本文本提取角色资产。
 * 流程：贴/选剧本文本 → AI 提取角色清单 → 用户勾选+编辑 → 批量创建为角色资产。
 * 只负责收集数据，写工程由父组件完成（复用 persistProject）。
 */

export interface ExtractedChar {
  name: string
  alias: string
  description: string
  prompt: string
  tags: string[]
}

interface Row extends ExtractedChar {
  key: string
  picked: boolean
}

export function ScriptImportDialog({
  onClose,
  onImport
}: {
  onClose: () => void
  onImport: (chars: ExtractedChar[]) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    setFileName(file.name)
    try {
      const content = await file.text()
      setText(content)
      setRows([])
    } catch (err) {
      setError(`读取文件失败：${String((err as Error).message ?? err)}`)
    }
  }

  const extract = async (): Promise<void> => {
    const t = text.trim()
    if (!t) {
      setError('请先粘贴剧本文本，或选择一个 .txt / .md 剧本文件')
      return
    }
    setExtracting(true)
    setError(null)
    setRows([])
    try {
      const list = await window.api.aiExtractCharacters({ text: t })
      if (!Array.isArray(list) || list.length === 0) {
        setError('没有从剧本里识别到角色。可以在剧本里明确写出人物姓名与对白再试。')
        return
      }
      setRows(
        list.map((c, i) => ({
          key: `${i}-${c.name}`,
          name: c.name ?? '',
          alias: c.alias ?? '',
          description: c.description ?? '',
          prompt: c.prompt ?? '',
          tags: Array.isArray(c.tags) ? c.tags : [],
          picked: true
        }))
      )
    } catch (err) {
      setError(`提取失败：${String((err as Error).message ?? err)}`)
    } finally {
      setExtracting(false)
    }
  }

  const patch = (key: string, fields: Partial<Row>): void => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...fields } : r)))
  }

  const save = async (): Promise<void> => {
    const chosen = rows.filter((r) => r.picked && r.name.trim())
    if (chosen.length === 0) {
      setError('至少勾选一个角色')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onImport(
        chosen.map((r) => ({
          name: r.name.trim(),
          alias: r.alias.trim(),
          description: r.description.trim(),
          prompt: r.prompt.trim(),
          tags: r.tags
        }))
      )
      onClose()
    } catch (err) {
      setError(`创建资产失败：${String((err as Error).message ?? err)}`)
    } finally {
      setSaving(false)
    }
  }

  const pickedCount = rows.filter((r) => r.picked && r.name.trim()).length

  return (
    <Modal
      title="导入剧本 · 提取角色资产"
      onClose={onClose}
      size="xl"
      footer={
        <>
          {rows.length > 0 && (
            <span className="mr-auto text-[11px] text-slate-500">已选 {pickedCount} 个角色</span>
          )}
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          {rows.length > 0 && (
            <button className="btn-primary" disabled={saving || pickedCount === 0} onClick={() => void save()}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {saving ? '创建中…' : `创建 ${pickedCount} 个角色资产`}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* 步骤说明 */}
        <div className="flex items-center gap-2 rounded-lg bg-accent-600/10 px-3 py-2 text-[11px] text-accent-200/90">
          <Sparkles size={13} className="shrink-0" />
          ① 放入剧本文本 → ② AI 提取角色 → ③ 勾选确认 → 创建成角色资产。生成图后，在提示词里写角色名即可绑定参考图。
        </div>

        {/* 剧本文本输入 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="label mb-0">剧本文本</label>
            <button className="btn-ghost py-1 text-[11px]" onClick={() => fileRef.current?.click()}>
              <Upload size={13} />
              选择 .txt / .md 文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
          </div>
          {fileName && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-slate-500">
              <FileText size={11} />
              {fileName}
            </div>
          )}
          <textarea
            className="field min-h-[150px] w-full resize-y font-mono text-[11px] leading-relaxed"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setRows([])
            }}
            placeholder="把剧本粘贴到这里，例如：&#10;&#10;第一场 内景 咖啡馆&#10;林小雨：（端起咖啡）你今天怎么这么晚？&#10;陈默：路上堵车。她是谁？&#10;……"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-slate-600">{text.length} 字（最多送 2 万字给 AI）</span>
            <button className="btn-primary" disabled={extracting || !text.trim()} onClick={() => void extract()}>
              {extracting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {extracting ? '提取中…' : '提取角色'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{error}</div>
        )}

        {/* 角色清单（可编辑） */}
        {rows.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="label mb-0">识别到 {rows.length} 个角色（可修改）</label>
              <button
                className="text-[11px] text-slate-500 hover:text-slate-300"
                onClick={() => setRows((prev) => prev.map((r) => ({ ...r, picked: true })))}
              >
                全选
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.key}
                  className={`rounded-lg border p-2.5 ${
                    r.picked ? 'border-accent-500/40 bg-accent-600/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        r.picked ? 'border-accent-500 bg-accent-600 text-white' : 'border-white/20'
                      }`}
                      onClick={() => patch(r.key, { picked: !r.picked })}
                      title={r.picked ? '取消勾选' : '勾选创建'}
                    >
                      {r.picked && <Check size={11} />}
                    </button>
                    <input
                      className="field min-w-0 flex-1 py-1 text-[12px]"
                      value={r.name}
                      onChange={(e) => patch(r.key, { name: e.target.value })}
                      placeholder="角色名"
                    />
                    <input
                      className="field w-40 py-1 text-[11px]"
                      value={r.alias}
                      onChange={(e) => patch(r.key, { alias: e.target.value })}
                      placeholder="别名（逗号分隔）"
                    />
                  </div>
                  <input
                    className="field mt-1.5 w-full py-1 text-[11px]"
                    value={r.description}
                    onChange={(e) => patch(r.key, { description: e.target.value })}
                    placeholder="一句话描述（身份 / 性格）"
                  />
                  <textarea
                    className="field mt-1.5 w-full resize-y py-1 font-mono text-[10px] leading-relaxed"
                    rows={2}
                    value={r.prompt}
                    onChange={(e) => patch(r.key, { prompt: e.target.value })}
                    placeholder="形象生成提示词（英文，可生成后再改）"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
