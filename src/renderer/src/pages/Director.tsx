import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Film, Play, SlidersHorizontal, Wand2 } from 'lucide-react'
import type { Shot, Template } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { NoProject } from '../components/NoProject'
import { ShotStatusBadge } from '../components/badges'
import { MediaImage } from '../components/MediaImage'

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index

/** 导演台默认模板：优先用户所选；否则优先 H3/MiniMax/BanZhang 视频模板；再退其它视频/首个 */
function pickDirectorTemplate(templates: Template[], id: string): Template | null {
  return (
    templates.find((t) => t.id === id) ??
    templates.find((t) => t.kind === 'video' && /H3|MiniMax|BanZhang|三采/i.test(t.name)) ??
    templates.find((t) => t.kind === 'video') ??
    templates[0] ??
    null
  )
}

/** 从模板 apiJson 读取第一个 KSampler 的默认采样参数 */
function ksDefaults(apiJson: unknown): { steps?: number; cfg?: number; samplerName?: string; scheduler?: string } {
  if (!apiJson || typeof apiJson !== 'object') return {}
  for (const n of Object.values(apiJson as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>)) {
    if (String(n?.class_type) === 'KSampler' && n.inputs) {
      const i = n.inputs
      return {
        steps: typeof i.steps === 'number' ? i.steps : undefined,
        cfg: typeof i.cfg === 'number' ? i.cfg : undefined,
        samplerName: typeof i.sampler_name === 'string' ? i.sampler_name : undefined,
        scheduler: typeof i.scheduler === 'string' ? i.scheduler : undefined
      }
    }
  }
  return {}
}

export default function Director(): React.JSX.Element {
  const project = useApp((s) => s.project)
  const hardware = useApp((s) => s.hardware)
  const navigate = useNavigate()

  const [episodeId, setEpisodeId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [submittingShotId, setSubmittingShotId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  // 生成参数（可调）
  const [paramsOpen, setParamsOpen] = useState(false)
  const [genSteps, setGenSteps] = useState('')
  const [genCfg, setGenCfg] = useState('')
  const [genSampler, setGenSampler] = useState('')
  const [genScheduler, setGenScheduler] = useState('')
  const [genWidth, setGenWidth] = useState('')
  const [genHeight, setGenHeight] = useState('')
  const [genFrames, setGenFrames] = useState('')
  const [genSeed, setGenSeed] = useState('')

  // 切换模板/硬件档位时，预填默认参数（steps/cfg/采样器/调度器/宽高帧数）
  const hwKey = hardware?.preset.video ? `${hardware.preset.video.width}x${hardware.preset.video.height}x${hardware.preset.video.frames}` : ''
  useEffect(() => {
    const p = useApp.getState().project
    if (!p) return
    const t = pickDirectorTemplate(p.templates, templateId)
    const ks = ksDefaults(t?.apiJson)
    const pv = useApp.getState().hardware?.preset.video
    setGenSteps(String(ks.steps ?? 4))
    setGenCfg(String(ks.cfg ?? 1))
    setGenSampler(ks.samplerName ?? 'euler')
    setGenScheduler(ks.scheduler ?? 'simple')
    setGenWidth(String(pv?.width ?? 576))
    setGenHeight(String(pv?.height ?? 320))
    setGenFrames(String(pv?.frames ?? 33))
    setGenSeed('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, hwKey])

  if (!project) {
    return (
      <div>
        <PageHeader title="导演台" desc="按集编排镜头时间线，引用角色资产并提交生成" />
        <div className="px-8 pb-8">
          <NoProject />
        </div>
      </div>
    )
  }

  if (project.episodes.length === 0) {
    return (
      <div>
        <PageHeader title="导演台" desc="按集编排镜头时间线，引用角色资产并提交生成" />
        <div className="px-8 pb-8">
          <EmptyState title="还没有剧集" desc="先去「剧本分镜」创建剧集、场次与分镜" />
        </div>
      </div>
    )
  }

  const episodes = [...project.episodes].sort(byIndex)
  const selectedEpisode = episodes.find((e) => e.id === episodeId) ?? episodes[0]

  const scenes = project.scenes.filter((s) => s.episodeId === selectedEpisode.id).sort(byIndex)
  const sceneById = new Map(scenes.map((s) => [s.id, s]))
  const shots = project.shots
    .filter((sh) => sceneById.has(sh.sceneId))
    .sort((a, b) => {
      const sa = sceneById.get(a.sceneId)
      const sb = sceneById.get(b.sceneId)
      if (!sa || !sb) return 0
      return sa.index - sb.index || a.index - b.index
    })

  const template = pickDirectorTemplate(project.templates, templateId)
  const preset = hardware?.preset.video ?? null
  const canGenerate = Boolean(template && preset)
  const pendingCount = shots.filter((s) => s.outputs.length === 0).length

  const generateHint = (): string | undefined => {
    if (!template) return '项目还没有工作流模板，先在设置里导入'
    if (!preset) return '尚未检测到硬件档位，无法确定生成参数'
    return undefined
  }

  const submitJob = async (shot: Shot): Promise<void> => {
    if (!template || !preset) return
    // 收集分镜引用资产的封面图作为视频参考图（H3 ref2va 素材）
    const refImages = shot.assetIds
      .map((id) => project.assets.find((a) => a.id === id)?.coverFile)
      .filter((f): f is string => Boolean(f))
    const num = (s: string, d: number): number => {
      const n = Number(s)
      return Number.isFinite(n) && n > 0 ? n : d
    }
    await window.api.jobGenerate({
      projectId: project.id,
      shotId: shot.id,
      templateId: template.id,
      positive: shot.prompt || shot.description || shot.title,
      width: num(genWidth, preset.width),
      height: num(genHeight, preset.height),
      frames: num(genFrames, preset.frames),
      steps: genSteps ? num(genSteps, 0) || undefined : undefined,
      cfg: genCfg ? Number(genCfg) || undefined : undefined,
      samplerName: genSampler.trim() || undefined,
      scheduler: genScheduler.trim() || undefined,
      seed: genSeed.trim() ? Number(genSeed) || undefined : undefined,
      refImages: refImages.length > 0 ? refImages : undefined
    })
  }

  const generateOne = async (shot: Shot): Promise<void> => {
    setSubmittingShotId(shot.id)
    try {
      await submitJob(shot)
      navigate('/queue')
    } finally {
      setSubmittingShotId(null)
    }
  }

  const generateAll = async (): Promise<void> => {
    if (!canGenerate || batchRunning) return
    setBatchRunning(true)
    try {
      for (const shot of shots) {
        if (shot.outputs.length > 0) continue
        setSubmittingShotId(shot.id)
        await submitJob(shot)
      }
      navigate('/queue')
    } finally {
      setSubmittingShotId(null)
      setBatchRunning(false)
    }
  }

  const assetName = (id: string): string => project.assets.find((a) => a.id === id)?.name ?? id

  return (
    <div>
      <PageHeader
        title="导演台"
        desc="按集编排镜头时间线，引用角色资产并提交生成"
        crumbs={[project.name, '导演台']}
      />

      <div className="px-8 pb-8">
        <div className="mb-4 flex items-center gap-3">
          <select
            className="field w-80"
            value={selectedEpisode.id}
            onChange={(e) => setEpisodeId(e.target.value)}
          >
            {episodes.map((ep) => {
              const script = project.scripts.find((s) => s.id === ep.scriptId)
              return (
                <option key={ep.id} value={ep.id}>
                  {script ? `${script.name} · ` : ''}
                  {ep.title}
                </option>
              )
            })}
          </select>
          <span className="text-xs text-slate-500">
            {shots.length} 个分镜 · {pendingCount} 个待生成
          </span>
          {project.templates.length > 1 && (
            <select
              className="field w-56"
              value={template?.id ?? ''}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {project.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'video' ? '视频 · ' : '图片 · '}
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto">
            <button
              className="btn-ghost"
              disabled={!canGenerate || batchRunning || pendingCount === 0}
              onClick={() => void generateAll()}
            >
              <Play size={15} />
              {batchRunning ? '提交中…' : `连续生成（${pendingCount}）`}
            </button>
          </div>
        </div>

        {/* 生成参数（可调） */}
        <div className="mb-4">
          <button
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
            onClick={() => setParamsOpen((v) => !v)}
          >
            {paramsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <SlidersHorizontal size={14} />
            生成参数（步数 / CFG / 采样器 / 调度器 / 分辨率 / 帧数 / 种子）
          </button>
          {paramsOpen && (
            <div className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="label">步数 steps</label>
                  <input className="field" value={genSteps} onChange={(e) => setGenSteps(e.target.value.replace(/[^0-9]/g, ''))} placeholder="4" />
                </div>
                <div>
                  <label className="label">CFG</label>
                  <input className="field" value={genCfg} onChange={(e) => setGenCfg(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="1" />
                </div>
                <div>
                  <label className="label">采样器 sampler</label>
                  <input className="field" list="sampler-list" value={genSampler} onChange={(e) => setGenSampler(e.target.value)} placeholder="euler" />
                  <datalist id="sampler-list">
                    {['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'res_multistep', 'ddim', 'uni_pc'].map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="label">调度器 scheduler</label>
                  <input className="field" list="sched-list" value={genScheduler} onChange={(e) => setGenScheduler(e.target.value)} placeholder="simple" />
                  <datalist id="sched-list">
                    {['simple', 'normal', 'karras', 'exponential', 'beta', 'sgm_uniform', 'ddim_uniform'].map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="label">宽</label>
                  <input className="field" value={genWidth} onChange={(e) => setGenWidth(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
                <div>
                  <label className="label">高</label>
                  <input className="field" value={genHeight} onChange={(e) => setGenHeight(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
                <div>
                  <label className="label">帧数</label>
                  <input className="field" value={genFrames} onChange={(e) => setGenFrames(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
                <div>
                  <label className="label">种子（空=随机）</label>
                  <input className="field" value={genSeed} onChange={(e) => setGenSeed(e.target.value.replace(/[^0-9]/g, ''))} placeholder="随机" />
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-600">
                默认值取自当前工作流。H3 的「SelfLift 分段步数」会按步数自动对齐；显存吃紧时调低分辨率/帧数。
              </div>
            </div>
          )}
        </div>

        {!canGenerate && (
          <div className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
            {generateHint()}
          </div>
        )}

        {shots.length === 0 ? (
          <EmptyState title="该剧集下还没有分镜" desc="先去「剧本分镜」为场次添加镜头" />
        ) : (
          <div className="space-y-3">
            {shots.map((shot) => {
              const scene = sceneById.get(shot.sceneId)
              const characters = shot.characterIds.map(assetName)
              return (
                <div key={shot.id} className="panel flex items-center gap-4 p-4">
                  <div className="h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-white/5 bg-ink-800">
                    <MediaImage
                      src={shot.refImage}
                      alt={shot.title}
                      className="h-full w-full object-cover"
                      fallback={
                        <div className="flex h-full w-full items-center justify-center text-slate-600">
                          <Film size={22} />
                        </div>
                      }
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">
                        {scene ? `S${scene.index}.` : ''}
                        {shot.index} {shot.title || '未命名分镜'}
                      </span>
                      <ShotStatusBadge status={shot.status} />
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {shot.duration}s · {shot.outputs.length} 输出
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {shot.description || '暂无画面描述'}
                    </div>
                    {characters.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {characters.map((name) => (
                          <span
                            key={name}
                            className="rounded bg-accent-600/15 px-1.5 py-0.5 text-[11px] text-accent-400"
                          >
                            {name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    className="btn-primary shrink-0"
                    disabled={!canGenerate || submittingShotId === shot.id || batchRunning}
                    title={generateHint()}
                    onClick={() => void generateOne(shot)}
                  >
                    <Wand2 size={14} />
                    {submittingShotId === shot.id ? '提交中…' : '生成'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
