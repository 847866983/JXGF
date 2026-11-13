import { useState } from 'react'
import { Image, Wand2 } from 'lucide-react'
import type { Asset } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'

/**
 * 资产生图对话框：选图片模板 + 提示词，生成图片作为资产封面。
 * 生成完成后图片自动写入 asset.images + coverFile，可在剧本分镜中引用。
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

  const [templateId, setTemplateId] = useState(imageTemplates[0]?.id ?? '')
  const [positive, setPositive] = useState(asset.prompt || asset.description || '')
  const [negative, setNegative] = useState(asset.negative || '')
  const [width, setWidth] = useState('1024')
  const [height, setHeight] = useState('1024')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    if (!project) return
    if (!templateId) {
      setError('请先选择一个图片工作流模板')
      return
    }
    if (!positive.trim()) {
      setError('请填写提示词')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.jobGenerate({
        projectId: project.id,
        assetId: asset.id,
        templateId,
        positive: positive.trim(),
        negative: negative.trim() || undefined,
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
      title={`为「${asset.name}」生成封面图`}
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

        <div>
          <label className="label">正面提示词</label>
          <textarea
            className="field min-h-[80px] resize-y"
            value={positive}
            onChange={(e) => setPositive(e.target.value)}
            placeholder="描述要生成的画面（默认取资产的 prompt）"
          />
        </div>

        <div>
          <label className="label">负面提示词（可留空）</label>
          <textarea
            className="field min-h-[48px] resize-y"
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
          />
        </div>

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
