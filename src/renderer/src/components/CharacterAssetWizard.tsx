import { useEffect, useMemo, useState } from 'react'
import { Check, ImagePlus, Loader2, Pencil, Save, ScanFace, Trash2, Wand2 } from 'lucide-react'
import type { Asset, JobInfo } from '@shared/types'
import { useApp } from '../store/app'
import { Modal } from './Modal'
import { MediaImage } from './MediaImage'
import { persistProject } from './mutate'
import {
  pickQwenT2ITemplate,
  pickQwenEditTemplate,
  buildCharacterT2IInput,
  buildCharacterFourViewInput,
  buildCharacterEditInput,
  filterRenderableVersions,
  type AssetJobInput
} from '../lib/assetGen'

const JOB_TIMEOUT_MS = 15 * 60 * 1000
const POLL_INTERVAL_MS = 2000

/** 轮询任务状态；任务不存在时也继续等（可能尚未登记），超时返回 timeout */
async function waitForJob(jobId: string, onTick?: (pct: number) => void): Promise<'done' | 'failed' | 'timeout'> {
  const started = Date.now()
  for (;;) {
    try {
      const jobs: JobInfo[] = await window.api.jobList()
      const job = jobs.find((j) => j.id === jobId)
      if (job) {
        onTick?.(job.progress ?? 0)
        if (job.status === 'done') return 'done'
        if (job.status === 'failed' || job.status === 'cancelled') return 'failed'
      }
    } catch {
      // 单次读失败忽略，继续轮询
    }
    if (Date.now() - started > JOB_TIMEOUT_MS) return 'timeout'
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

/**
 * 角色资产工作台：
 *   大图预览 → 可编辑提示词（可保存）→ 生成新版（每版都保留，可删除）
 *   → 选一版做局部编辑 → 确认后转四视图 → 设为角色绑定图
 */
export function CharacterAssetWizard({ asset, onClose }: { asset: Asset; onClose: () => void }): React.JSX.Element {
  const project = useApp((s) => s.project)
  const projectId = project?.id

  /** 始终读 store 里的最新资产，避免拿到过期快照 */
  const live = useMemo(
    () => useApp.getState().project?.assets.find((a) => a.id === asset.id) ?? asset,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, asset.id]
  )

  const templates = project?.templates ?? []
  const versions = filterRenderableVersions(live.images)

  const [prompt, setPrompt] = useState(live.prompt || live.description || '')
  const [dirty, setDirty] = useState(false)
  const [selected, setSelected] = useState<string | null>(live.coverFile ?? versions[versions.length - 1] ?? null)
  const [editOpen, setEditOpen] = useState(false)
  const [editPrompt, setEditPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // 资产提示词在别处（编辑弹窗）改动后，同步回输入框（用户正在编辑时不覆盖）
  useEffect(() => {
    if (dirty) return
    setPrompt(live.prompt || live.description || '')
  }, [live.prompt, live.description, dirty])

  // 新版本产生后自动选中最新一版
  useEffect(() => {
    if (versions.length === 0) return
    setSelected((cur) => (cur && versions.includes(cur) ? cur : versions[versions.length - 1]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions.join('|')])

  /** 保存提示词到资产（并刷新项目，让编辑弹窗也看到新提示词） */
  const savePrompt = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text) {
      setError('提示词不能为空')
      return
    }
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === asset.id)
      if (a) {
        a.prompt = text
        a.updatedAt = new Date().toISOString()
      }
    })
    setDirty(false)
    if (projectId) await useApp.getState().openProject(projectId)
    setStatus('提示词已保存')
    window.setTimeout(() => setStatus(null), 2000)
  }

  /** 提交生成任务：立刻给出「已提交」反馈，再轮询结果 */
  const submit = async (
    build: () => AssetJobInput | null,
    label: string,
    missingMsg: string
  ): Promise<string | null> => {
    if (busy) return null
    const input = build()
    if (!input) {
      setError(missingMsg)
      return null
    }
    if (!projectId) {
      setError('项目未打开')
      return null
    }
    setBusy(true)
    setError(null)
    setProgress(0)
    setStatus(`正在提交「${label}」…`)
    const before = new Set(useApp.getState().project?.assets.find((a) => a.id === asset.id)?.images ?? [])
    try {
      const job = await window.api.jobGenerate({
        projectId,
        assetId: asset.id,
        templateId: input.templateId,
        positive: input.positive,
        negative: input.negative,
        width: input.width,
        height: input.height,
        batch: input.batch,
        refImages: input.refImages && input.refImages.length > 0 ? input.refImages : undefined
      })
      setStatus(`已提交「${label}」，等待生成…（任务 ${job.id.slice(-6)}）`)
      const outcome = await waitForJob(job.id, setProgress)
      if (outcome !== 'done') {
        setError(
          outcome === 'timeout'
            ? `「${label}」超时（超过 15 分钟），请到「生成队列」查看`
            : `「${label}」失败，请到「生成队列」查看错误`
        )
        return null
      }
      await useApp.getState().openProject(projectId)
      const after = useApp.getState().project?.assets.find((a) => a.id === asset.id)?.images ?? []
      const added = after.filter((f) => !before.has(f))
      const newest = added[added.length - 1] ?? after[after.length - 1] ?? null
      if (!newest) {
        setError('生成完成但没有拿到产物，请重试')
        return null
      }
      setSelected(newest)
      setStatus(null)
      return newest
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
      return null
    } finally {
      setBusy(false)
      setProgress(0)
    }
  }

  const generateNew = async (): Promise<void> => {
    // 点生成视为确认使用当前提示词：未保存就先落盘，避免"改了提示词但资产里还是旧的"
    if (dirty) {
      try {
        await savePrompt()
      } catch {
        // 保存失败不阻断生成，仅提示
        setError('提示词保存失败，但会用当前内容生成')
      }
    }
    const img = await submit(
      () => buildCharacterT2IInput({ ...live, prompt: prompt.trim() }, templates),
      '生成形象',
      '缺少千问文生图模板，请先在「设置 → 导入工作流」导入千问文生图'
    )
    if (img) setEditOpen(false)
  }

  const applyEdit = async (): Promise<void> => {
    const instruction = editPrompt.trim()
    if (!selected) return
    if (!instruction) {
      setError('请先填写修改指令')
      return
    }
    const img = await submit(
      () => buildCharacterEditInput(live, templates, undefined, selected, instruction),
      '局部编辑',
      '缺少千问「全能编辑」工作流模板'
    )
    if (img) {
      setEditOpen(false)
      setEditPrompt('')
    }
  }

  const toFourView = async (): Promise<void> => {
    if (!selected) return
    await submit(
      () => buildCharacterFourViewInput(live, templates, undefined, selected),
      '转四视图',
      '缺少千问「全能编辑」工作流模板（转四视图需要它 + 参考图）'
    )
  }

  const removeVersion = async (img: string): Promise<void> => {
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === asset.id)
      if (!a) return
      a.images = a.images.filter((x) => x !== img)
      if (a.coverFile === img) a.coverFile = a.images[0] ?? null
      a.updatedAt = new Date().toISOString()
    })
    void window.api.mediaDeleteFile(img)
    if (projectId) await useApp.getState().openProject(projectId)
    setSelected((cur) => (cur === img ? null : cur))
  }

  const useAsCover = async (img: string): Promise<void> => {
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === asset.id)
      if (a) {
        a.coverFile = img
        a.updatedAt = new Date().toISOString()
      }
    })
    if (projectId) await useApp.getState().openProject(projectId)
    setStatus('已设为角色绑定图')
    window.setTimeout(() => setStatus(null), 2000)
  }

  const hasT2I = Boolean(pickQwenT2ITemplate(templates))
  const hasEdit = Boolean(pickQwenEditTemplate(templates))

  return (
    <Modal
      title={`角色资产 · ${live.name}`}
      size="wide"
      onClose={onClose}
      footer={
        <button className="btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      {/* 宽屏双栏：左=大图+版本，右=提示词+操作 */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
        {/* 左栏 */}
        <div className="space-y-4">
          {/* 1. 大图预览 */}
          <div className="overflow-hidden rounded-xl border border-white/10 bg-ink-950">
            {selected ? (
              <MediaImage
                src={selected}
                alt="当前角色图"
                className="max-h-[560px] min-h-[300px] w-full object-contain"
                fallback={
                  <div className="flex h-64 w-full items-center justify-center text-sm text-slate-600">图片加载失败</div>
                }
              />
            ) : (
              <div className="flex h-64 w-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
                <ImagePlus size={28} />
                还没有生成图，先在右侧填提示词并生成
              </div>
            )}
          </div>

          {/* 4. 版本列表 */}
          <div>
            <div className="mb-1.5 text-xs text-slate-500">
              已保存版本 <span className="text-slate-300">{versions.length}</span> 个（点选一版用于编辑 / 转四视图）
            </div>
            {versions.length === 0 ? (
              <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-slate-500">还没有版本</div>
            ) : (
              <div className="grid max-h-[190px] grid-cols-6 gap-2 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-2 xl:grid-cols-8">
                {versions.map((img) => {
                  const active = selected === img
                  const bound = live.coverFile === img
                  return (
                    <div
                      key={img}
                      className={`group relative aspect-square overflow-hidden rounded border ${
                        active ? 'border-accent-500 ring-1 ring-accent-500' : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      <button type="button" className="h-full w-full" title={img} onClick={() => setSelected(img)}>
                        <MediaImage
                          src={img}
                          alt=""
                          className="h-full w-full object-cover"
                          fallback={<div className="h-full w-full bg-ink-800" />}
                        />
                      </button>
                      {bound && (
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-accent-600/80 text-center text-[9px] text-white">
                          绑定图
                        </span>
                      )}
                      <button
                        type="button"
                        title="删除这一版"
                        className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded bg-black/70 text-[10px] text-white hover:bg-rose-600 group-hover:flex"
                        onClick={() => void removeVersion(img)}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右栏 */}
        <div className="space-y-3">
          {/* 2. 提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="label mb-0">提示词（可修改，保存后生效）</label>
              <button
                className={`btn-ghost !px-2.5 !py-1 text-xs ${dirty ? 'text-accent-400' : 'text-slate-500'}`}
                onClick={() => void savePrompt()}
                disabled={busy || !dirty}
                title="把提示词保存到资产"
              >
                <Save size={13} />
                {dirty ? '保存提示词' : '已保存'}
              </button>
            </div>
            <textarea
              className="field min-h-[220px] resize-y leading-relaxed"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                setDirty(true)
              }}
              placeholder="描述角色外形 / 服装 / 发型 / 气质…"
            />
          </div>

          {/* 3. 生成新版 */}
          <button
            className="btn-primary w-full"
            disabled={busy || !prompt.trim() || !hasT2I}
            onClick={() => void generateNew()}
            title={hasT2I ? '按提示词生成一版新形象' : '缺少千问文生图模板'}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
            生成新版形象
          </button>
          {!hasT2I && <div className="text-xs text-amber-400/80">缺少千问文生图模板，无法生成形象</div>}

          {/* 5. 局部编辑 */}
          {selected && (
            <div className="space-y-2 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Pencil size={12} />
                  局部编辑（基于选中版本修改）
                </span>
                {!editOpen && (
                  <button
                    className="btn-ghost !px-2 !py-1 text-xs"
                    disabled={busy || !hasEdit}
                    onClick={() => setEditOpen(true)}
                  >
                    展开
                  </button>
                )}
              </div>
              {editOpen && (
                <>
                  <textarea
                    className="field min-h-[80px] resize-y"
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="例如：短发改成长发、外套换成黑色、去掉眼镜…"
                  />
                  <div className="flex gap-2">
                    <button
                      className="btn-primary flex-1"
                      disabled={busy || !editPrompt.trim() || !hasEdit}
                      onClick={() => void applyEdit()}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                      应用编辑
                    </button>
                    <button className="btn-ghost" disabled={busy} onClick={() => setEditOpen(false)}>
                      收起
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 6. 确认动作 */}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-ghost" disabled={busy || !selected || !hasEdit} onClick={() => void toFourView()}>
              <ScanFace size={15} />
              确定，转四视图
            </button>
            <button
              className="btn-primary"
              disabled={busy || !selected}
              onClick={() => selected && void useAsCover(selected)}
            >
              <Check size={15} />
              设为角色图
            </button>
          </div>
          {!hasEdit && selected && (
            <div className="text-xs text-amber-400/80">缺少千问「全能编辑」模板，无法编辑或转四视图</div>
          )}

          {/* 状态 / 错误 */}
          {busy && (
            <div className="space-y-2 rounded-lg bg-accent-600/10 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm text-accent-400">
                <Loader2 size={15} className="animate-spin" />
                {status ?? '生成中…'}
              </div>
              {progress > 0 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-accent-500 transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          )}
          {!busy && status && <div className="text-xs text-emerald-400">{status}</div>}
          {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
        </div>
      </div>
    </Modal>
  )
}
