import { useState } from 'react'
import { Image, ScanFace, Wand2 } from 'lucide-react'
import type { Asset } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'

/**
 * 资产生图对话框：选图片模板 + 提示词，生成图片作为资产封面。
 * 角色资产：默认用「Z-Image-Turbo」并自动套「四视图」提示词（正/四分之三/侧/背）。
 * 生成完成后图片自动写入 asset.images + coverFile，可在剧本分镜中引用。
 */

// 四视图提示词模板（英文，适配 Z-Image / 扩散模型）
const FOUR_VIEW_HEAD =
  'character turnaround reference sheet, the same single character shown in four full-body views arranged in one row: front view, three-quarter view, side view, back view; consistent face, hairstyle, outfit and colors across all views; full body, standing neutral pose; plain light gray studio background; '
const FOUR_VIEW_TAIL =
  ' ; clean character design sheet, high detail, sharp focus, professional concept art'
const FOUR_VIEW_NEG =
  'multiple different characters, inconsistent design, different outfit between views, extra heads, extra limbs, deformed, bad anatomy, text, watermark, logo, signature, cropped, out of frame, blurry, low quality'

function buildFourViewPositive(desc: string): string {
  const d = desc.trim().replace(/[;,\s]+$/, '')
  return d ? `${FOUR_VIEW_HEAD}${d}${FOUR_VIEW_TAIL}` : `${FOUR_VIEW_HEAD}a character${FOUR_VIEW_TAIL}`
}

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
  const defaultTemplate =
    (isCharacter && imageTemplates.find((t) => /Z-?Image-?Turbo/i.test(t.name))) ||
    imageTemplates.find((t) => /Z-?Image/i.test(t.name)) ||
    imageTemplates[0]

  const [templateId, setTemplateId] = useState(defaultTemplate?.id ?? '')
  const [positive, setPositive] = useState(asset.prompt || asset.description || '')
  const [negative, setNegative] = useState(asset.negative || '')
  const [fourView, setFourView] = useState(isCharacter)
  const [width, setWidth] = useState(isCharacter ? '1024' : '1024')
  const [height, setHeight] = useState(isCharacter ? '1024' : '1024')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    if (!project) return
    if (!templateId) {
      setError('请先选择一个图片工作流模板')
      return
    }
    if (!positive.trim() && !fourView) {
      setError('请填写提示词')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const finalPositive = fourView ? buildFourViewPositive(positive) : positive.trim()
      const finalNegative = fourView ? FOUR_VIEW_NEG : negative.trim() || undefined
      await window.api.jobGenerate({
        projectId: project.id,
        assetId: asset.id,
        templateId,
        positive: finalPositive,
        negative: finalNegative,
        width: Number(width) || undefined,
        height: Number(height) || undefined
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
                生成角色四视图（正 / 四分之三 / 侧 / 背）
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                勾选后会把下面的描述套进「角色转身参考表」四视图提示词，用 Z-Image-Turbo 一次出四视图。取消则按普通单图生成。
              </span>
            </span>
          </label>
        )}

        <div>
          <label className="label">{fourView ? '角色描述（会套进四视图模板）' : '正面提示词'}</label>
          <textarea
            className="field min-h-[80px] resize-y"
            value={positive}
            onChange={(e) => setPositive(e.target.value)}
            placeholder={fourView ? '描述这个角色的外形/服装/发型等（默认取资产的 prompt）' : '描述要生成的画面（默认取资产的 prompt）'}
          />
        </div>

        {!fourView && (
          <div>
            <label className="label">负面提示词（可留空）</label>
            <textarea
              className="field min-h-[48px] resize-y"
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">宽</label>
            <input className="field" value={width} onChange={(e) => setWidth(e.target.value)} />
          </div>
          <div>
            <label className="label">高</label>
            <input className="field" value={height} onChange={(e) => setHeight(e.target.value)} />
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-500">
          <Image size={14} className="mt-0.5 shrink-0 text-accent-400" />
          生成完成后，图片会自动作为该资产的封面，可在「剧本分镜」里引用此资产做视频生成。
        </div>

        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
    </Modal>
  )
}
