import { useState } from 'react'
import { Image, ScanFace, Wand2 } from 'lucide-react'
import type { Asset } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'
import { MediaImage } from './MediaImage'
import {
  DEFAULT_STYLE_ID,
  STYLES,
  buildFourViewPositive,
  fourViewNegative,
  pickAssetTemplate,
  styledPositive
} from '../lib/assetGen'

/**
 * 资产生图对话框：选 画风 + 模板 + 提示词，生成图片作为资产封面。
 * 角色资产：默认用「Z-Image-Turbo」并套「四视图」提示词（上半身特写 + 全身正/侧/背）。
 * 支持「参考图」：选中图片后传给它 = 图片编辑 / 图生图（千问全能编辑等模板专用）。
 */

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

  // 角色默认选 Z-Image-Turbo
  const defaultTemplate = pickAssetTemplate(project?.templates ?? [], asset.kind)

  const [templateId, setTemplateId] = useState(defaultTemplate?.id ?? '')
  const [styleId, setStyleId] = useState(DEFAULT_STYLE_ID)
  const [positive, setPositive] = useState(asset.prompt || asset.description || '')
  const [negative, setNegative] = useState(asset.negative || '')
  const [fourView, setFourView] = useState(isCharacter)
  const [width, setWidth] = useState(isCharacter ? '1536' : '640')
  const [height, setHeight] = useState(isCharacter ? '640' : '640')
  const [batch, setBatch] = useState('1')
  const [refImages, setRefImages] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 可选参考图：本资产已有图 + 项目内其它资产图
  const otherAssets = (project?.assets ?? []).filter((a) => a.id !== asset.id)
  const refPool: { file: string; label: string }[] = [
    ...asset.images.map((f) => ({ file: f, label: '本资产' })),
    ...otherAssets.flatMap((a) =>
      [a.coverFile, ...a.images].filter((f): f is string => Boolean(f)).map((f) => ({ file: f, label: a.name }))
    )
  ]
  // 去重
  const seen = new Set<string>()
  const refCandidates = refPool.filter((r) => {
    if (seen.has(r.file)) return false
    seen.add(r.file)
    return true
  })

  const toggleRef = (file: string): void => {
    setRefImages((prev) => (prev.includes(file) ? prev.filter((x) => x !== file) : [...prev, file]))
  }

  const generate = async (): Promise<void> => {
    if (!project) return
    if (!templateId) {
      setError('请先选择一个图片工作流模板')
      return
    }
    if (!positive.trim() && !fourView && refImages.length === 0) {
      setError('请填写提示词（或至少选一张参考图）')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // 有参考图时不做四视图套模板（编辑模式应当尊重用户提示词）
      const useFourView = fourView && refImages.length === 0
      const finalPositive = useFourView ? buildFourViewPositive(positive) : styledPositive(positive)
      const finalNegative = useFourView
        ? fourViewNegative()
        : negative.trim() || undefined
      await window.api.jobGenerate({
        projectId: project.id,
        assetId: asset.id,
        templateId,
        positive: finalPositive,
        negative: finalNegative,
        width: Number(width) || undefined,
        height: Number(height) || undefined,
        batch: Number(batch) || 1,
        refImages: refImages.length > 0 ? refImages : undefined
      })
      onClose()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={isCharacter ? `为「${asset.name}」生成角色四视图` : `为「${asset.name}」生成封面图`}
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
        <div>
          <label className="label">图片工作流模板</label>
          {imageTemplates.length === 0 ? (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
              还没有图片工作流，请先在「设置 → 导入工作流」导入生图模板。
            </div>
          ) : (
            <select className="field" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {imageTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {isCharacter && (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-accent/40 bg-accent-600/[0.08] px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5 accent-[#7c5cff]"
              checked={fourView}
              onChange={(e) => setFourView(e.target.checked)}
            />
            <span className="text-sm text-slate-200">
              <span className="flex items-center gap-1.5 font-medium">
                <ScanFace size={14} className="text-accent-400" />
                生成角色四视图（上半身特写 + 全身正/侧/背）
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                勾选后把下面的描述套进「角色四视图」模板：一张上半身特写（面部细节清晰）+ 全身正、侧、背三视。取消则按普通单图生成。
              </span>
            </span>
          </label>
        )}

        <div>
          <label className="label">{fourView ? '角色描述（会套进四视图模板）' : '正面提示词'}</label>
          <textarea
            className="field min-h-[150px] resize-y leading-relaxed"
            value={positive}
            onChange={(e) => setPositive(e.target.value)}
            placeholder={fourView ? '描述这个角色的外形/服装/发型等（默认取资产的 prompt）' : '描述要生成的画面（默认取资产的 prompt）'}
          />
        </div>

        {!fourView && (
          <div>
            <label className="label">负面提示词（可留空）</label>
            <textarea
              className="field min-h-[80px] resize-y leading-relaxed"
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
            />
          </div>
        )}

        {/* 参考图：选中后即「图片编辑 / 图生图」，配合千问全能编辑等模板 */}
        <div>
          <label className="label">
            参考图（可多选）{refImages.length > 0 && <span className="ml-1 text-accent-400">已选 {refImages.length} 张 · 图片编辑模式</span>}
          </label>
          {refCandidates.length === 0 ? (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-slate-500">
              暂无可选图片。先生成一张，或在其它资产里生成图后再来选。
            </div>
          ) : (
            <div className="grid max-h-[132px] grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-2">
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
                      <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent-600 text-[10px] text-white">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-1 text-[11px] text-slate-600">
            选参考图后走「图片编辑/图生图」：保留参考图内容按提示词改写。千问「全能编辑」等模板需要此项。
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label">宽</label>
            <input className="field" value={width} onChange={(e) => setWidth(e.target.value)} />
          </div>
          <div>
            <label className="label">高</label>
            <input className="field" value={height} onChange={(e) => setHeight(e.target.value)} />
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
        <div className="text-[11px] text-slate-600">张数 &gt; 1 会一次出多张，完成后可在资产里挑一张设为绑定图（显存吃紧时建议 1~2）。</div>

        <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-500">
          <Image size={14} className="mt-0.5 shrink-0 text-accent-400" />
          生成完成后，图片会自动作为该资产的封面，可在「剧本分镜」里引用此资产做视频生成。
        </div>

        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
    </Modal>
  )
}
