import { useState } from 'react'
import { Bookmark, ChevronDown, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { PromptEditor } from './PromptEditor'

/**
 * 文案台面板 —— 把 ComfyUI H3 文案台（CSGlideDeskCS）搬到镜序工坊。
 *
 * 后端 compose_text 规则（h3-prompt.ts 的 composeDeskText）：
 *   片子级 global 在前 + 本段 seg 在后 → h3_data.prompt。
 * 所以这里把「片子级」「本段」两栏并排摆，让用户一眼看清最终提示词的组成。
 *
 * presets 是文案台上的可点快捷短语：点一下追加到**本段**提示词末尾，
 * 对应 desk_data.presets（不自动进提示词，只有点了才拼）。
 */

export interface DeskPanelProps {
  /** 片子级提示词草稿 */
  globalPrompt: string
  onGlobalPrompt: (v: string) => void
  onSaveGlobal: () => void
  /** 本段提示词 */
  segmentPrompt: string
  onSegmentPrompt: (v: string) => void
  onSaveSegment: () => void
  /** 当前段引用的资产名（提示词里出现即高亮） */
  names: string[]
  /** 快捷短语列表 */
  presets: string[]
  /** 改快捷短语（全片一份） */
  onPresets: (list: string[]) => void
  disabled?: boolean
}

export default function DeskPanel(props: DeskPanelProps): React.JSX.Element {
  const { globalPrompt, segmentPrompt, presets } = props
  const [globalOpen, setGlobalOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const appendPreset = (text: string): void => {
    if (props.disabled) return
    const next = `${segmentPrompt.trimEnd()}${segmentPrompt.trim() ? '\n' : ''}${text}`
    props.onSegmentPrompt(next)
  }

  const addPreset = (): void => {
    const t = draft.trim()
    if (!t) return
    props.onPresets([...presets, t])
    setDraft('')
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={13} className="text-accent-400" />
        <span className="text-[11px] font-medium text-slate-300">文案台</span>
        <span className="ml-auto text-[11px] text-slate-500">片子级 + 本段 → 最终提示词</span>
      </div>

      {/* 本段提示词（主输入） */}
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] text-slate-500">本段提示词（自动保存）</label>
      </div>
      <PromptEditor
        value={segmentPrompt}
        onChange={props.onSegmentPrompt}
        onBlur={props.onSaveSegment}
        names={props.names}
        placeholder="描述这一段的画面、人物动作、镜头运动与声音…（写 @图片1 或角色名会高亮）"
        minHeight={130}
      />

      {/* presets 快捷短语：点一下追加到本段 */}
      <div className="mt-2 border-t border-white/[0.06] pt-2">
        <button
          className="flex w-full items-center gap-1.5 text-left text-[11px] text-slate-500 hover:text-slate-300"
          onClick={() => setPresetOpen((v) => !v)}
        >
          {presetOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Bookmark size={11} />
          快捷短语（{presets.length}）· 点一下追加到本段
        </button>
        {presetOpen && (
          <div className="mt-1.5">
            <div className="flex flex-wrap gap-1">
              {presets.map((p, i) => (
                <button
                  key={`${p}-${i}`}
                  className="group flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-400 hover:border-accent-500/40 hover:text-accent-200"
                  title={`追加：${p}`}
                  onClick={() => appendPreset(p)}
                >
                  {p}
                  <X
                    size={9}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onPresets(presets.filter((_, j) => j !== i))
                    }}
                  />
                </button>
              ))}
              {presets.length === 0 && <span className="text-[11px] text-slate-600">还没有快捷短语，在下面添加</span>}
            </div>
            <div className="mt-1.5 flex gap-1">
              <input
                className="field min-w-0 flex-1 text-[11px]"
                placeholder="新增快捷短语，如：镜头缓慢推近"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addPreset()
                  }
                }}
              />
              <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" onClick={addPreset} title="添加快捷短语">
                <Plus size={11} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 片子级提示词（全片统一基调，折叠收纳） */}
      <div className="mt-2 border-t border-white/[0.06] pt-2">
        <button
          className="flex w-full items-center gap-1.5 text-left text-[11px] text-slate-500 hover:text-slate-300"
          onClick={() => setGlobalOpen((v) => !v)}
        >
          {globalOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          片子级提示词（全片统一风格）
          {globalPrompt.trim() && <span className="rounded bg-accent-600/20 px-1 text-accent-300">已设置</span>}
        </button>
        {globalOpen && (
          <div className="mt-1.5">
            <PromptEditor
              value={globalPrompt}
              onChange={props.onGlobalPrompt}
              onBlur={props.onSaveGlobal}
              names={props.names}
              placeholder="全片统一的风格 / 基调 / 世界观，如：现代都市，霓虹夜景，冷色调，电影感构图"
              minHeight={80}
            />
            <div className="mt-1 text-[11px] text-slate-600">生成每段时自动拼在本段提示词前面。</div>
          </div>
        )}
      </div>
    </div>
  )
}
