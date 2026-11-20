import { useState } from 'react'
import { Layers, Wand2 } from 'lucide-react'
import type { AssetKind } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'
import { DEFAULT_STYLE_ID, STYLES, buildAssetJobInput } from '../lib/assetGen'

/**
 * 一键生成所有资产：按资产类型自动挑模板与提示词（角色→四视图，其它→单图），
 * 默认一律使用千问 Image 2.1 全能编辑模板。
 * 逐条提交到生成队列。默认跳过已有绑定图的资产，避免重复生成。
 */
export function AssetBatchGenerateDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useApp((s) => s.project)
  const [kinds, setKinds] = useState<Record<AssetKind, boolean>>({ character: true, scene: true, prop: true })
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [styleId, setStyleId] = useState(DEFAULT_STYLE_ID)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const assets = project?.assets ?? []
  const templates = project?.templates ?? []
  const imageTemplates = templates.filter((t) => t.kind === 'image')

  const targets = assets.filter(
    (a) => kinds[a.kind] && (!onlyMissing || !a.coverFile) && buildAssetJobInput(a, templates, styleId)
  )

  const run = async (): Promise<void> => {
    if (!project) return
    if (imageTemplates.length === 0) {
      setError('还没有图片工作流模板，请先在「设置 → 导入工作流」导入生图模板')
      return
    }
    if (targets.length === 0) {
      setError('没有需要生成的资产（可调整筛选条件）')
      return
    }
    setLoading(true)
    setError(null)
    setDone(null)
    try {
      let n = 0
      for (const a of targets) {
        const input = buildAssetJobInput(a, templates, styleId)
        if (!input) continue
        await window.api.jobGenerate({
          projectId: project.id,
          assetId: a.id,
          templateId: input.templateId,
          positive: input.positive,
          negative: input.negative,
          width: input.width,
          height: input.height,
          batch: input.batch
        })
        n += 1
      }
      setDone(n)
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setLoading(false)
    }
  }

  const kinds3: { id: AssetKind; label: string }[] = [
    { id: 'character', label: '角色（四视图）' },
    { id: 'scene', label: '场景' },
    { id: 'prop', label: '道具' }
  ]

  return (
    <Modal
      title="一键生成所有资产"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {done !== null ? '关闭' : '取消'}
          </button>
          <button className="btn-primary" disabled={loading} onClick={() => void run()}>
            <Wand2 size={15} />
            {loading ? '提交中…' : `生成 ${targets.length} 个`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-accent-600/[0.08] px-3 py-2.5 text-xs text-slate-300">
          <Layers size={15} className="mt-0.5 shrink-0 text-accent-400" />
          <span>
            将按类型自动生成：<b>角色</b>用千问 Image 2.1 出<b>四视图</b>，<b>场景/道具</b>出单图，逐条进「生成队列」。
            生成完回资产里可挑图设为绑定图。
          </span>
        </div>

        <div>
          <label className="label">包含类型</label>
          <div className="flex flex-wrap gap-2">
            {kinds3.map((k) => {
              const count = assets.filter((a) => a.kind === k.id && (!onlyMissing || !a.coverFile)).length
              return (
                <label
                  key={k.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                    kinds[k.id] ? 'border-accent/50 bg-accent-600/10 text-accent-300' : 'border-white/10 text-slate-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="accent-[#7c5cff]"
                    checked={kinds[k.id]}
                    onChange={(e) => setKinds((p) => ({ ...p, [k.id]: e.target.checked }))}
                  />
                  {k.label}
                  <span className="text-[11px] text-slate-500">{count}</span>
                </label>
              )
            })}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            className="accent-[#7c5cff]"
            checked={onlyMissing}
            onChange={(e) => setOnlyMissing(e.target.checked)}
          />
          只生成还没有绑定图的资产（建议勾选，避免重复）
        </label>

        {imageTemplates.length === 0 && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            还没有图片工作流模板，请先在「设置 → 导入工作流」导入生图模板。
          </div>
        )}

        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-slate-400">
          将生成 <b className="text-white">{targets.length}</b> 个资产
          {targets.length > 0 && (
            <span className="ml-1 text-slate-500">
              （{targets.slice(0, 3).map((a) => a.name).join('、')}
              {targets.length > 3 ? ' 等' : ''}）
            </span>
          )}
        </div>

        {done !== null && (
          <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            已提交 {done} 个生成任务，去「生成队列」查看进度；完成后图片会自动出现在资产里。
          </div>
        )}
        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
    </Modal>
  )
}
