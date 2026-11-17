import { useState } from 'react'
import { Check, Loader2, Pencil, RefreshCw, ScanFace, Wand2 } from 'lucide-react'
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
  type AssetJobInput
} from '../lib/assetGen'

type Step = 't2i' | 'branch' | 'result'
type JobOutcome = 'done' | 'failed' | 'timeout'

const JOB_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 3000

/**
 * 角色资产生成三步向导：
 *   1) 生成形象（千问文生图）→ 得到角色正面形象
 *   2) 满意 → 转四视图；不满意 → 编辑修改
 *   3) 预览结果 → 设为角色图（coverFile），编辑分支可继续编辑 / 转四视图
 * 每步产物由主进程自动追加进 asset.images，向导内展示历史缩略图可选。
 */

async function waitForJob(jobId: string, onProgress?: (pct: number) => void): Promise<JobOutcome> {
  const started = Date.now()
  for (;;) {
    const jobs: JobInfo[] = await window.api.jobList()
    const job = jobs.find((j) => j.id === jobId)
    if (job) {
      onProgress?.(job.progress ?? 0)
      if (job.status === 'done') return 'done'
      if (job.status === 'failed' || job.status === 'cancelled') return 'failed'
    }
    if (Date.now() - started > JOB_TIMEOUT_MS) return 'timeout'
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export function CharacterAssetWizard({
  asset,
  onClose
}: {
  asset: Asset
  onClose: () => void
}): React.JSX.Element {
  const project = useApp((s) => s.project)

  const [prompt, setPrompt] = useState(asset.prompt || asset.description || '')
  const [step, setStep] = useState<Step>('t2i')
  const [currentImage, setCurrentImage] = useState<string | null>(null)
  const [lastWasEdit, setLastWasEdit] = useState(false)
  const [editingOpen, setEditingOpen] = useState(false)
  const [editPrompt, setEditPrompt] = useState('')
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const templates = project?.templates ?? []
  const projectId = project?.id
  const historyImages = project?.assets.find((a) => a.id === asset.id)?.images ?? asset.images

  const latestImages = (): string[] => {
    const a = useApp.getState().project?.assets.find((x) => x.id === asset.id)
    return a?.images ?? asset.images
  }

  /** 提交一个资产生图任务并等待完成；成功返回该步产出的最新一张图 */
  const runJob = async (
    input: AssetJobInput | null,
    label: string,
    missingMsg: string
  ): Promise<string | null> => {
    if (!input) {
      setError(missingMsg)
      return null
    }
    if (!projectId) {
      setError('项目未打开')
      return null
    }
    setBusyLabel(label)
    setError(null)
    setProgress(0)
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
      const outcome = await waitForJob(job.id, setProgress)
      if (outcome !== 'done') {
        setError(
          outcome === 'timeout'
            ? '生成超时（超过 10 分钟），请到「生成队列」查看进度'
            : '生成失败，请到「生成队列」查看错误信息'
        )
        return null
      }
      await useApp.getState().openProject(projectId)
      const imgs = latestImages()
      return imgs[imgs.length - 1] ?? null
    } catch (err) {
      setError(String((err as Error).message ?? err))
      return null
    } finally {
      setBusyLabel(null)
      setProgress(0)
    }
  }

  const generateT2I = async (): Promise<void> => {
    const img = await runJob(
      // 步骤1 的提示词可编辑：把编辑后的文本作为 asset.prompt 传入（lib 内部取 prompt||description||name）
      buildCharacterT2IInput({ ...asset, prompt: prompt.trim() }, templates),
      '正在生成角色形象…',
      '缺少千问文生图模板，请先在「设置 → 导入工作流」导入千问文生图模板'
    )
    if (img) {
      setCurrentImage(img)
      setLastWasEdit(false)
      setEditingOpen(false)
      setStep('branch')
    }
  }

  const toFourView = async (): Promise<void> => {
    if (!currentImage) return
    const img = await runJob(
      buildCharacterFourViewInput(asset, templates, undefined, currentImage),
      '正在生成四视图…',
      '缺少千问编辑模板（转四视图需要「全能编辑」工作流 + 参考图）'
    )
    if (img) {
      setCurrentImage(img)
      setLastWasEdit(false)
      setEditingOpen(false)
      setStep('result')
    }
  }

  const applyEdit = async (): Promise<void> => {
    if (!currentImage) return
    const instruction = editPrompt.trim()
    if (!instruction) {
      setError('请先填写修改指令')
      return
    }
    const img = await runJob(
      buildCharacterEditInput(asset, templates, undefined, currentImage, instruction),
      '正在按指令修改…',
      '缺少千问编辑模板，请先在「设置 → 导入工作流」导入千问「全能编辑」工作流'
    )
    if (img) {
      setCurrentImage(img)
      setLastWasEdit(true)
      setEditingOpen(false)
      setStep('result')
    }
  }

  const setCover = async (): Promise<void> => {
    if (!currentImage) return
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === asset.id)
      if (a) {
        a.coverFile = currentImage
        a.updatedAt = new Date().toISOString()
      }
    })
    onClose()
  }

  const pickHistory = (img: string): void => {
    setCurrentImage(img)
    setLastWasEdit(false)
    setEditingOpen(false)
    setError(null)
    setStep('branch')
  }

  const busy = busyLabel !== null

  const historyStrip = (): React.JSX.Element => (
    <div>
      <div className="mb-1.5 text-xs text-slate-500">历史图（点选作为当前形象继续下一步）</div>
      {historyImages.length === 0 ? (
        <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-slate-500">
          还没有生成记录。
        </div>
      ) : (
        <div className="grid max-h-[120px] grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-2">
          {historyImages.map((img) => (
            <button
              key={img}
              type="button"
              title={img}
              onClick={() => pickHistory(img)}
              className={`relative aspect-square overflow-hidden rounded border ${
                currentImage === img
                  ? 'border-accent-500 ring-1 ring-accent-500'
                  : 'border-white/10 hover:border-white/30'
              }`}
            >
              <MediaImage
                src={img}
                alt=""
                className="h-full w-full object-cover"
                fallback={<div className="h-full w-full bg-ink-800" />}
              />
              {currentImage === img && (
                <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent-600 text-[10px] text-white">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <Modal
      title={`为「${asset.name}」生成角色形象`}
      onClose={onClose}
      footer={
        <button className="btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="space-y-4">
        {/* 步骤指示 */}
        <div className="flex items-center gap-2 text-xs">
          {(['t2i', 'branch', 'result'] as Step[]).map((s, i) => {
            const active = step === s
            const done = (s === 't2i' && (step === 'branch' || step === 'result')) || (s === 'branch' && step === 'result')
            return (
              <div key={s} className="flex items-center gap-2">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                    active
                      ? 'bg-accent-600 text-white'
                      : done
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-white/5 text-slate-500'
                  }`}
                >
                  {i + 1}
                </span>
                <span className={active ? 'text-slate-200' : 'text-slate-500'}>
                  {s === 't2i' ? '生成形象' : s === 'branch' ? '四视图 / 编辑' : '设为角色图'}
                </span>
                {i < 2 && <span className="mx-1 text-slate-700">→</span>}
              </div>
            )
          })}
        </div>

        {/* 步骤 1：生成形象 */}
        {(step === 't2i' || step === 'branch') && (
          <div className="space-y-3">
            <div>
              <label className="label">形象描述（默认取资产的 prompt）</label>
              <textarea
                className="field min-h-[120px] resize-y leading-relaxed"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述这个角色的外形 / 服装 / 发型等"
              />
            </div>
            <button className="btn-primary w-full" disabled={busy || !prompt.trim()} onClick={() => void generateT2I()}>
              <Wand2 size={15} />
              {busy && step === 't2i' ? busyLabel : '生成形象'}
            </button>
          </div>
        )}

        {/* 步骤 2：分支选择（有当前形象后） */}
        {step === 'branch' && currentImage && (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border border-white/5">
              <MediaImage
                src={currentImage}
                alt="当前形象"
                className="max-h-[280px] w-full object-contain bg-ink-950"
                fallback={<div className="flex h-40 w-full items-center justify-center bg-ink-950 text-slate-600">无预览</div>}
              />
            </div>

            {!editingOpen ? (
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-primary" disabled={busy} onClick={() => void toFourView()}>
                  <ScanFace size={15} />
                  满意，转四视图
                </button>
                <button className="btn-ghost" disabled={busy} onClick={() => setEditingOpen(true)}>
                  <Pencil size={15} />
                  不满意，编辑修改
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="label">修改指令（基于当前形象做图片编辑）</label>
                  <textarea
                    className="field min-h-[72px] resize-y"
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="例如：把短发改成长发、换成红色外套、去掉眼镜…"
                  />
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary flex-1" disabled={busy} onClick={() => void applyEdit()}>
                    <Wand2 size={15} />
                    应用编辑
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => setEditingOpen(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            <button
              className="btn-ghost w-full"
              disabled={busy}
              onClick={() => void generateT2I()}
              title="不基于当前图，按上面的描述重新生成一张新形象"
            >
              <RefreshCw size={12} />
              不用这张，重新生成形象
            </button>
          </div>
        )}

        {/* 步骤 3：结果预览 */}
        {step === 'result' && currentImage && (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border border-white/5">
              <MediaImage
                src={currentImage}
                alt={lastWasEdit ? '编辑结果' : '四视图'}
                className="max-h-[280px] w-full object-contain bg-ink-950"
                fallback={<div className="flex h-40 w-full items-center justify-center bg-ink-950 text-slate-600">无预览</div>}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-primary col-span-2" disabled={busy} onClick={() => void setCover()}>
                <Check size={15} />
                设为角色图
              </button>
              {lastWasEdit ? (
                <>
                  <button className="btn-ghost" disabled={busy} onClick={() => setEditingOpen(true)}>
                    <Pencil size={15} />
                    继续编辑
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => void toFourView()}>
                    <ScanFace size={15} />
                    转四视图
                  </button>
                </>
              ) : (
                <button className="btn-ghost col-span-2" disabled={busy} onClick={() => setStep('branch')}>
                  <RefreshCw size={15} />
                  返回重选
                </button>
              )}
            </div>
          </div>
        )}

        {/* 编辑面板在 result 的「继续编辑」时打开 */}
        {step === 'result' && lastWasEdit && editingOpen && (
          <div className="space-y-2 rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div>
              <label className="label">修改指令</label>
              <textarea
                className="field min-h-[72px] resize-y"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                placeholder="例如：把外套换成黑色、背景改成夜晚…"
              />
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" disabled={busy} onClick={() => void applyEdit()}>
                <Wand2 size={15} />
                应用编辑
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => setEditingOpen(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {/* 历史缩略图 */}
        {historyStrip()}

        {/* 忙碌状态 */}
        {busy && (
          <div className="space-y-2 rounded-lg bg-accent-600/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm text-accent-400">
              <Loader2 size={15} className="animate-spin" />
              {busyLabel}
            </div>
            {progress > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-accent-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}

        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
    </Modal>
  )
}
