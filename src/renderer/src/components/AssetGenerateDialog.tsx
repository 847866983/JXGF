import { useState } from 'react'
import { Image, ScanFace, Wand2 } from 'lucide-react'
import type { Asset, Template } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'
import { MediaImage } from './MediaImage'
import {
  QWEN_QUADVIEW_LORA,
  QWEN_QUADVIEW_PROMPT,
  fourViewNegative,
  pickAssetTemplate,
  pickQwenEditTemplate
} from '../lib/assetGen'

/**
 * 资产生图对话框（显式三模式）：
 *   文生图 t2i      —— 千问 / MOSS / Krea2 任选，无参考图
 *   图生编辑 edit    —— 选参考图 + 提示词改写（千问全能编辑等支持参考图的模板）
 *   四视图 fourView  —— 仅角色；千问编辑 + <mva> 触发词 + 多角度 LoRA（2400×1200, 8 步）
 *
 * 引擎能力联动：MOSS 模板是纯文生图（无参考图通道），选它时编辑/四视图禁用并引导。
 */

type GenMode = 't2i' | 'edit' | 'fourView'

const isMossTpl = (t: Template): boolean => /MOSS/i.test(t.name)
const isQwenTpl = (t: Template): boolean => /千问|Qwen/i.test(t.name)
const isKreaTpl = (t: Template): boolean => /Krea2/i.test(t.name)

/** 画布预设档（与向导/模板出厂口径一致）。千问文生图默认原生 2K
 *  （20261124 用户指定），四视图 2000×1200。 */
const CANVAS_PRESETS: { label: string; w: string; h: string }[] = [
  { label: '2048×2048 千问 2K（推荐）', w: '2048', h: '2048' },
  { label: '1328×1328 高清', w: '1328', h: '1328' },
  { label: '1024×1024 方形', w: '1024', h: '1024' },
  { label: '1184×896 MOSS', w: '1184', h: '896' },
  { label: '2000×1200 四视图', w: '2000', h: '1200' },
  { label: '1536×640 横幅', w: '1536', h: '640' }
]

export function AssetGenerateDialog({
  asset,
  onClose
}: {
  asset: Asset
  onClose: () => void
}): React.JSX.Element {
  const project = useApp((s) => s.project)
  const imageTemplates = (project?.templates ?? []).filter((t) => t.kind === 'image')
  const isCharacter = asset.kind === 'character'

  const defaultTemplate = pickAssetTemplate(project?.templates ?? [], asset.kind)

  const [templateId, setTemplateId] = useState(defaultTemplate?.id ?? '')
  const [mode, setMode] = useState<GenMode>(isCharacter ? 'fourView' : 't2i')
  const [positive, setPositive] = useState(asset.prompt || asset.description || '')
  const [negative, setNegative] = useState(asset.negative || '')
  const [width, setWidth] = useState(isCharacter ? '2000' : '2048')
  const [height, setHeight] = useState(isCharacter ? '1200' : '2048')
  const [batch, setBatch] = useState('1')
  const [refImages, setRefImages] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTemplate = imageTemplates.find((t) => t.id === templateId)
  const mossSelected = Boolean(selectedTemplate && isMossTpl(selectedTemplate))

  // 可选参考图：本资产已有图 + 项目内其它资产图
  const otherAssets = (project?.assets ?? []).filter((a) => a.id !== asset.id)
  const refPool: { file: string; label: string }[] = [
    ...asset.images.map((f) => ({ file: f, label: '本资产' })),
    ...otherAssets.flatMap((a) =>
      [a.coverFile, ...a.images].filter((f): f is string => Boolean(f)).map((f) => ({ file: f, label: a.name }))
    )
  ]
  const seen = new Set<string>()
  const refCandidates = refPool.filter((r) => {
    if (seen.has(r.file)) return false
    seen.add(r.file)
    return true
  })

  const toggleRef = (file: string): void => {
    setRefImages((prev) => (prev.includes(file) ? prev.filter((x) => x !== file) : [...prev, file]))
  }

  /** 切模式：自动对齐推荐模板与画布（用户可再改） */
  const switchMode = (m: GenMode): void => {
    setMode(m)
    if (m === 'fourView') {
      const qwen = pickQwenEditTemplate(imageTemplates)
      if (qwen) setTemplateId(qwen.id)
      setWidth('2000')
      setHeight('1200')
      setRefImages([])
    } else if (m === 'edit') {
      const qwen = pickQwenEditTemplate(imageTemplates)
      if (qwen) setTemplateId(qwen.id)
      setWidth('')
      setHeight('') // 跟随参考图（canvas_from_ref）
    } else {
      setWidth('2048')
      setHeight('2048')
    }
  }

  /** 模板手动切换时的能力联动：MOSS 只能文生图 */
  const switchTemplate = (id: string): void => {
    setTemplateId(id)
    const t = imageTemplates.find((x) => x.id === id)
    if (t && isMossTpl(t) && mode !== 't2i') {
      setMode('t2i')
      setWidth('1184')
      setHeight('896')
      setRefImages([])
    }
  }

  const generate = async (): Promise<void> => {
    if (!project) return
    if (!templateId) {
      setError('请先选择一个图片工作流模板')
      return
    }
    if (mode === 'edit' && refImages.length === 0) {
      setError('图生编辑模式需要至少选一张参考图（或切换到文生图模式）')
      return
    }
    if (!positive.trim() && mode !== 'fourView' && refImages.length === 0) {
      setError('请填写提示词（或至少选一张参考图）')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // 四视图：<mva> 触发词 → 用户描述 → 结构说明（顺序关键，描述会被长段模板压掉）
      const structPart = QWEN_QUADVIEW_PROMPT.replace(/^<mva>\s*/, '')
      const finalPositive =
        mode === 'fourView' ? `<mva> ${positive.trim() || asset.name || 'character'}\n\n${structPart}` : positive
      const finalNegative =
        mode === 'fourView' ? fourViewNegative() : negative.trim() || undefined

      // 四视图必须挂多角度 LoRA + 8 步（与角色向导同口径）；MOSS 纯文生图保持模板原配步数
      const isQwenFour = mode === 'fourView'
      const tpl = imageTemplates.find((t) => t.id === templateId)
      await window.api.jobGenerate({
        projectId: project.id,
        assetId: asset.id,
        templateId,
        positive: finalPositive,
        negative: finalNegative,
        width: Number(width) || undefined,
        height: Number(height) || undefined,
        batch: Number(batch) || 1,
        steps: isQwenFour ? 8 : undefined,
        loras: isQwenFour ? [{ file: QWEN_QUADVIEW_LORA, strength: 0.9 }] : undefined,
        refImages: mode === 'edit' && refImages.length > 0 ? refImages : undefined
      })
      onClose()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  // 模板按引擎分组渲染
  const groups: { label: string; items: Template[] }[] = [
    { label: '千问 Qwen（支持参考图）', items: imageTemplates.filter(isQwenTpl) },
    { label: 'MOSS（纯文生图）', items: imageTemplates.filter(isMossTpl) },
    { label: 'Krea2', items: imageTemplates.filter(isKreaTpl) },
    { label: '其它', items: imageTemplates.filter((t) => !isQwenTpl(t) && !isMossTpl(t) && !isKreaTpl(t)) }
  ].filter((g) => g.items.length > 0)

  const modeDefs: { key: GenMode; label: string; hint: string; disabled?: string }[] = [
    { key: 't2i', label: '文生图', hint: '按提示词直接生成' },
    { key: 'edit', label: '图生编辑', hint: '选参考图后按提示词改写' },
    {
      key: 'fourView',
      label: '四视图',
      hint: '特写+正/侧/背',
      disabled: isCharacter ? undefined : '仅角色资产可用'
    }
  ]

  return (
    <Modal
      title={isCharacter ? `为「${asset.name}」生成角色图` : `为「${asset.name}」生成封面图`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={submitting} onClick={() => void generate()}>
            <Wand2 size={15} />
            {submitting ? '提交中…' : '生成'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 一、生成模式 */}
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">生成模式</span>
            {mossSelected && <span className="text-[11px] text-amber-300">MOSS 为纯文生图引擎</span>}
          </div>
          <div className="flex gap-1.5">
            {modeDefs.map((m) => {
              const disabled = Boolean(m.disabled) || (mossSelected && m.key !== 't2i')
              const active = mode === m.key
              return (
                <button
                  key={m.key}
                  type="button"
                  disabled={disabled}
                  title={disabled ? m.disabled ?? 'MOSS 不支持参考图，请改用千问模板' : m.hint}
                  onClick={() => !disabled && switchMode(m.key)}
                  className={`flex-1 rounded-md border px-2 py-2 text-xs transition-colors ${
                    active
                      ? 'border-accent-500 bg-accent-600/20 text-accent-200'
                      : disabled
                        ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-slate-600'
                        : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1 font-medium">
                    {m.key === 'fourView' && <ScanFace size={13} />}
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] opacity-60">{disabled ? '不可用' : m.hint}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 二、工作流模板 */}
        <div>
          <label className="label">图片工作流模板</label>
          {imageTemplates.length === 0 ? (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              还没有图片工作流模板。
            </div>
          ) : (
            <select className="field" value={templateId} onChange={(e) => switchTemplate(e.target.value)}>
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>

        {/* 三、提示词 */}
        <div>
          <label className="label">
            {mode === 'fourView'
              ? '角色描述（会套进四视图模板）'
              : mode === 'edit'
                ? '编辑指令（怎么改参考图）'
                : '正面提示词'}
          </label>
          <textarea
            className="field min-h-[110px] resize-y leading-relaxed"
            value={positive}
            onChange={(e) => setPositive(e.target.value)}
            placeholder={
              mode === 'fourView'
                ? '描述角色的外形/服装/发型等（默认取资产的 prompt）'
                : mode === 'edit'
                  ? '例如：把头发改成银白色，保持服装和姿势不变'
                  : '描述要生成的画面（默认取资产的 prompt）'
            }
          />
        </div>

        {mode !== 'fourView' && (
          <div>
            <label className="label">负面提示词（可留空）</label>
            <textarea
              className="field min-h-[64px] resize-y leading-relaxed"
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
            />
          </div>
        )}

        {/* 四、参考图（仅图生编辑） */}
        {mode === 'edit' && (
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <label className="label">
              参考图（可多选）{refImages.length > 0 && <span className="ml-1 text-accent-400">已选 {refImages.length} 张</span>}
            </label>
            {refCandidates.length === 0 ? (
              <div className="text-[11px] text-slate-500">
                暂无可选图片。先用「文生图」模式生成一张，再回来选它做编辑。
              </div>
            ) : (
              <div className="grid max-h-[132px] grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/60 p-2">
                {refCandidates.map((r) => {
                  const picked = refImages.includes(r.file)
                  return (
                    <button
                      key={r.file}
                      type="button"
                      title={r.label}
                      onClick={() => toggleRef(r.file)}
                      className={`relative aspect-square overflow-hidden rounded border ${
                        picked ? 'border-accent-500 ring-1 ring-accent-500' : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      <MediaImage
                        src={r.file}
                        alt=""
                        className="h-full w-full object-cover"
                        fallback={<div className="h-full w-full bg-ink-800" />}
                      />
                      {picked && (
                        <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent-600 text-[11px] text-white">
                          ✓
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-1.5 text-[11px] text-slate-600">
              画布自动跟随参考图尺寸；需要固定画布可在下方「画布」里填。
            </div>
          </div>
        )}

        {/* 五、画布与张数 */}
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-xs text-slate-500">预设：</span>
            {CANVAS_PRESETS.map((p) => {
              const active = width === p.w && height === p.h
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setWidth(p.w)
                    setHeight(p.h)
                  }}
                  className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                    active ? 'border-accent-500 bg-accent-600/20 text-accent-200' : 'border-white/10 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">宽</label>
              <input className="field" value={width} onChange={(e) => setWidth(e.target.value.replace(/[^0-9]/g, ''))} placeholder="跟随参考图" />
            </div>
            <div>
              <label className="label">高</label>
              <input className="field" value={height} onChange={(e) => setHeight(e.target.value.replace(/[^0-9]/g, ''))} placeholder="跟随参考图" />
            </div>
            <div>
              <label className="label">张数</label>
              <input
                className="field"
                value={batch}
                onChange={(e) => setBatch(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="1"
              />
            </div>
          </div>
          <div className="mt-1.5 text-[11px] text-slate-600">
            {mode === 'edit'
              ? '编辑模式留空宽高 = 画布跟随参考图；张数 > 1 一次出多张（显存吃紧建议 1~2）。'
              : '张数 > 1 会一次出多张，完成后可在资产里挑一张设为绑定图（显存吃紧时建议 1~2）。'}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-500">
          <Image size={14} className="mt-0.5 shrink-0 text-accent-400" />
          {mode === 'fourView'
            ? '四视图 = 上半身特写 + 全身正/侧/背（千问多角度 LoRA，画布 2000×1200）。完成后到「角色资产」向导里可切分镜引用。'
            : '生成完成后，图片会自动作为该资产的封面，可在「剧本分镜」里引用此资产做视频生成。'}
        </div>

        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
    </Modal>
  )
}
