import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Film, Link2, Play, SlidersHorizontal, Wand2 } from 'lucide-react'
import type { Shot, Template, SegmentSettings } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { NoProject } from '../components/NoProject'
import { ShotStatusBadge } from '../components/badges'
import { MediaImage } from '../components/MediaImage'
import { VideoThumb } from '../components/VideoThumb'
import { Modal } from '../components/Modal'
import { persistProject } from '../components/mutate'
import { defaultSegment, framesFor, getSegment, ratioOf } from '../lib/segment'
import Storyboard from './Storyboard'

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index

/** 按项目 + 剧集计算分镜时间线（组件渲染与连续生成循环共用，避免闭包拿旧数据） */
function computeShots(p: { episodes: { id: string; index: number }[]; scenes: { id: string; episodeId: string; index: number }[]; shots: Shot[] }, episodeId: string): Shot[] {
  const episodes = [...p.episodes].sort(byIndex)
  const ep = episodes.find((e) => e.id === episodeId) ?? episodes[0]
  if (!ep) return []
  const scenes = p.scenes.filter((s) => s.episodeId === ep.id).sort(byIndex)
  const sceneById = new Map(scenes.map((s) => [s.id, s]))
  return p.shots
    .filter((sh) => sceneById.has(sh.sceneId))
    .sort((a, b) => {
      const sa = sceneById.get(a.sceneId)
      const sb = sceneById.get(b.sceneId)
      if (!sa || !sb) return 0
      return sa.index - sb.index || a.index - b.index
    })
}

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
  const [tab, setTab] = useState<'segment' | 'storyboard'>('segment')
  const [templateId, setTemplateId] = useState('')
  const [selectedShotId, setSelectedShotId] = useState('')
  const [paramsShotId, setParamsShotId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [submittingShotId, setSubmittingShotId] = useState<string | null>(null)
  /** 生成前校验错误（如参考图缺失），显示在页面顶部提示 */
  const [error, setError] = useState<string | null>(null)

  // 全局采样参数（KSampler，应用于所有段）
  const [paramsOpen, setParamsOpen] = useState(false)
  const [genSteps, setGenSteps] = useState('')
  const [genCfg, setGenCfg] = useState('')
  const [genSampler, setGenSampler] = useState('')
  const [genScheduler, setGenScheduler] = useState('')
  const [genSeed, setGenSeed] = useState('')

  const hwKey = hardware?.preset.video
    ? `${hardware.preset.video.width}x${hardware.preset.video.height}x${hardware.preset.video.frames}`
    : ''
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
    setGenSeed('')
    void pv
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, hwKey])

  const tabBar = (
    <div className="flex items-center gap-2 px-8 pt-4">
      <button className={tab === 'segment' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('segment')}>
        分段导演
      </button>
      <button className={tab === 'storyboard' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('storyboard')}>
        剧本与分镜
      </button>
    </div>
  )

  // 剧本与分镜直接整合进导演台
  if (tab === 'storyboard') {
    return (
      <div>
        {tabBar}
        <Storyboard />
      </div>
    )
  }

  if (!project) {
    return (
      <div>
        <PageHeader title="导演台" desc="分段编排、逐段生成并续接成长视频" />
        <div className="px-8 pb-8">
          <NoProject />
        </div>
      </div>
    )
  }

  if (project.episodes.length === 0) {
    return (
      <div>
        <PageHeader title="导演台" desc="分段编排、逐段生成并续接成长视频" />
        <div className="px-8 pb-8">
          <EmptyState title="还没有剧集" desc="先去「剧本分镜」创建剧集、场次与分镜" />
        </div>
      </div>
    )
  }

  const episodes = [...project.episodes].sort(byIndex)
  const selectedEpisode = episodes.find((e) => e.id === episodeId) ?? episodes[0]

  const shots = computeShots(project, selectedEpisode.id)

  const template = pickDirectorTemplate(project.templates, templateId)
  const preset = hardware?.preset.video ?? null
  const canGenerate = Boolean(template && preset)
  const pendingCount = shots.filter((s) => s.outputs.length === 0).length
  const selectedShot = shots.find((s) => s.id === selectedShotId) ?? shots[0] ?? null
  const selectedIndex = selectedShot ? shots.indexOf(selectedShot) : -1

  const segOf = (shot: Shot): SegmentSettings => getSegment(shot, preset, shots.indexOf(shot))
  const seg = selectedShot ? segOf(selectedShot) : null
  const totalSec = shots.reduce((sum, s) => sum + segOf(s).durationSec, 0)

  const num = (s: string, d: number): number => {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : d
  }

  const buildH3 = (shot: Shot, index: number): Record<string, unknown> => {
    const s = segOf(shot)
    const chainName = `${project.name}·${selectedEpisode.title}`
    const clip = `clip_${String(index + 1).padStart(4, '0')}`
    const h3: Record<string, unknown> = {
      mode: s.genMode === 't2v' ? 't2v' : 'ref2va',
      ratio: s.ratio,
      pin_head: s.pinHead,
      pin_tail: s.pinTail,
      ref_image_size: s.refImageSize,
      ref_video_size: s.refVideoSize,
      ref_video_fps: s.refVideoFps,
      ref_scale_hd: s.refScaleHd,
      bridge_adapter: s.bridgeAdapter,
      bridge_alpha: s.bridgeAlpha,
      bridge_mode: s.bridgeMode,
      pace: s.pace,
      push_whole: s.pushWhole,
      chain: { name: chainName, clip, shot: shot.id }
    }
    if (s.contMode !== 'none') h3.cont = { mode: s.contMode }
    return h3
  }

  const submitJob = async (shot: Shot, index: number): Promise<void> => {
    if (!template || !preset) return
    // 用 store 里最新项目数据（连续生成时上一段产物刚写回，闭包里的 project 是旧的）
    const liveProject = useApp.getState().project ?? project
    const liveShots = computeShots(liveProject, selectedEpisode.id)
    const s = getSegment(shot, preset, index)
    // 参考图：仅「参考图」模式；参考视频：仅「视频参考」模式，取上一段成片
    // 封面缺失时回退用资产的第一张图，避免"有图但无封面"导致参考图为空
    // refAliases：把资产名一并传给主进程，H3 靠它把提示词里的角色名绑定到参考图
    const refPicks =
      s.genMode === 'ref2va'
        ? shot.assetIds
            .map((id) => {
              const a = liveProject.assets.find((x) => x.id === id)
              if (!a) return null
              const file = a.coverFile ?? a.images?.[a.images.length - 1] ?? null
              return file ? { file, name: a.name } : null
            })
            .filter((x): x is { file: string; name: string } => Boolean(x))
        : []
    const refImages = refPicks.map((x) => x.file)
    const refAliases = refPicks.map((x) => x.name)
    // 参考图模式下没有任何可用参考图 → 明确报错，避免静默生成不带参考的视频
    if (s.genMode === 'ref2va' && refImages.length === 0 && shot.assetIds.length > 0) {
      const names = shot.assetIds
        .map((id) => liveProject.assets.find((x) => x.id === id)?.name ?? id)
        .join('、')
      setError(
        `参考图缺失：分镜引用的资产（${names}）还没有生成过图片。` +
          `请先到「资产」页给这些资产生成图片（或把已有图片设为绑定图），再回来生成。` +
          `若想不用参考图直接生成，请把本段生成方式改成「纯文生」。`
      )
      return
    }
    let refVideos: string[] = []
    if (s.genMode === 'video') {
      const prev = liveShots[index - 1]
      const prevVideos = (prev?.outputs ?? [])
        .filter((o) => o.kind === 'video' && o.kept !== false)
        .map((o) => o.file)
      if (prevVideos.length > 0) refVideos = [prevVideos[prevVideos.length - 1]]
    }
    // 角色位置/动作拼进提示词
    const notes = shot.characterNotes ?? {}
    const charDesc = shot.assetIds
      .map((id) => {
        const a = liveProject.assets.find((x) => x.id === id)
        const note = (notes[id] ?? '').trim()
        return a && note ? `${a.name}：${note}` : ''
      })
      .filter(Boolean)
      .join('；')
    const basePrompt = shot.prompt || shot.description || shot.title
    const positive = charDesc ? `${basePrompt}\n角色位置与动作：${charDesc}` : basePrompt

    await window.api.jobGenerate({
      projectId: project.id,
      shotId: shot.id,
      templateId: template.id,
      positive,
      width: s.width,
      height: s.height,
      frames: s.frames,
      steps: genSteps ? num(genSteps, 0) || undefined : undefined,
      cfg: genCfg ? Number(genCfg) || undefined : undefined,
      samplerName: genSampler.trim() || undefined,
      scheduler: genScheduler.trim() || undefined,
      seed: genSeed.trim() ? Number(genSeed) || undefined : undefined,
      h3: buildH3(shot, index),
      upscale: s.upscale,
      rife: s.rife,
      refImages: refImages.length > 0 ? refImages : undefined,
      refAliases: refAliases.length > 0 ? refAliases : undefined,
      refVideos: refVideos.length > 0 ? refVideos : undefined
    })
  }

  /** 轮询等待某个任务完成（主进程队列顺序执行，完成后 project 快照已刷新） */
  const waitJobDone = async (shotId: string, timeoutMs = 45 * 60 * 1000): Promise<'done' | 'failed' | 'timeout'> => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 3000))
      const jobs = (await window.api.jobList()) as { shotId?: string; status: string }[]
      const job = jobs.find((j) => j.shotId === shotId)
      if (!job) return 'timeout' // 任务不在队列（可能已被清理），保守当作失败
      if (job.status === 'done') {
        // 重新拉项目快照，确保拿到刚写回的产物
        await useApp.getState().openProject(useApp.getState().project?.id ?? '')
        return 'done'
      }
      if (job.status === 'failed' || job.status === 'cancelled') return 'failed'
    }
    return 'timeout'
  }

  const generateOne = async (shot: Shot): Promise<void> => {
    const index = shots.indexOf(shot)
    setSubmittingShotId(shot.id)
    try {
      await submitJob(shot, index)
      navigate('/queue')
    } finally {
      setSubmittingShotId(null)
    }
  }

  /** 连续生成：按时间线顺序逐段生成，每段完成后再提交下一段。
   *  这样「视频参考」模式能拿到上一段刚生成的成片；latent 续接同样按序走链。 */
  const generateAll = async (): Promise<void> => {
    if (!canGenerate || batchRunning) return
    setBatchRunning(true)
    try {
      // 每轮用最新项目数据重算分镜（上一段产物写回后 store 已刷新）
      const liveP = useApp.getState().project
      const liveShots = liveP ? computeShots(liveP, selectedEpisode.id) : shots
      for (let i = 0; i < liveShots.length; i += 1) {
        const s = liveShots[i]
        if (s.outputs.length > 0) continue
        await submitJob(s, i)
        const result = await waitJobDone(s.id)
        if (result === 'failed') {
          // 失败后停止连续生成，让用户去队列看原因，避免后续段空跑
          break
        }
      }
      navigate('/queue')
    } finally {
      setBatchRunning(false)
    }
  }

  const saveSegment = async (shotId: string, next: SegmentSettings): Promise<void> => {
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (sh) {
        sh.segment = next
        sh.updatedAt = new Date().toISOString()
      }
    })
  }

  /** 快捷改单段参数（续接方式 / 生成方式按钮用），立即保存 */
  const patchSegment = async (shot: Shot, patch: Partial<SegmentSettings>): Promise<void> => {
    await saveSegment(shot.id, { ...segOf(shot), ...patch })
  }

  /** 选定某个产物为保留版本（其余标记弃用） */
  const keepOutput = async (shotId: string, outputId: string): Promise<void> => {
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (!sh) return
      for (const o of sh.outputs) o.kept = o.id === outputId
      sh.updatedAt = new Date().toISOString()
    })
  }

  /** 删除某个产物（不删磁盘文件，仅从分镜移除） */
  const removeOutput = async (shotId: string, outputId: string): Promise<void> => {
    const shot = project.shots.find((s) => s.id === shotId)
    const output = shot?.outputs.find((o) => o.id === outputId)
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (!sh) return
      sh.outputs = sh.outputs.filter((o) => o.id !== outputId)
      sh.updatedAt = new Date().toISOString()
    })
    // 清理磁盘文件（主进程检查是否仍被引用，如被下一段视频参考引用则保留）
    if (output?.file) void window.api.mediaDeleteFile(output.file)
  }

  const hint = (): string | undefined => {
    if (!template) return '项目还没有工作流模板，先在设置里导入'
    if (!preset) return '尚未检测到硬件档位，无法确定生成参数'
    return undefined
  }

  return (
    <div>
      {tabBar}
      <PageHeader title="导演台" desc="分段编排 · 每段画布/参考/放大重绘 · 段间续接成长视频" crumbs={[project.name, '导演台']} />

      <div className="px-8 pb-8">
        {/* 生成前校验错误提示（如参考图缺失） */}
        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <div className="flex-1 text-xs leading-relaxed text-amber-200">{error}</div>
            <button className="shrink-0 text-amber-400 hover:text-amber-200" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {/* 顶栏 */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select className="field w-80" value={selectedEpisode.id} onChange={(e) => setEpisodeId(e.target.value)}>
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
          {project.templates.length > 1 && (
            <select className="field w-56" value={template?.id ?? ''} onChange={(e) => setTemplateId(e.target.value)}>
              {project.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'video' ? '视频 · ' : '图片 · '}
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <span className="text-xs text-slate-500">
            {shots.length} 段 · 总时长 {totalSec.toFixed(1)}s · {pendingCount} 段待生成
          </span>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" onClick={() => setParamsOpen((v) => !v)}>
              <SlidersHorizontal size={15} />
              采样参数
            </button>
            <button className="btn-primary" disabled={!canGenerate || batchRunning || pendingCount === 0} onClick={() => void generateAll()}>
              <Play size={15} />
              {batchRunning ? '提交中…' : `连续生成（${pendingCount}）`}
            </button>
          </div>
        </div>

        {/* 全局采样参数 */}
        {paramsOpen && (
          <div className="mb-4 grid grid-cols-5 gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div>
              <label className="label">步数</label>
              <input className="field" value={genSteps} onChange={(e) => setGenSteps(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <div>
              <label className="label">CFG</label>
              <input className="field" value={genCfg} onChange={(e) => setGenCfg(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <div>
              <label className="label">采样器</label>
              <input className="field" value={genSampler} onChange={(e) => setGenSampler(e.target.value)} />
            </div>
            <div>
              <label className="label">调度器</label>
              <input className="field" value={genScheduler} onChange={(e) => setGenScheduler(e.target.value)} />
            </div>
            <div>
              <label className="label">种子（空=随机）</label>
              <input className="field" value={genSeed} onChange={(e) => setGenSeed(e.target.value.replace(/[^0-9]/g, ''))} placeholder="随机" />
            </div>
          </div>
        )}

        {!canGenerate && <div className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">{hint()}</div>}

        {shots.length === 0 ? (
          <EmptyState title="本集还没有分镜" desc="先去「剧本分镜」给本集添加场次与分镜" />
        ) : (
          <>
            {/* 全片总览时间线 */}
            <div className="panel mb-4 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <Link2 size={14} className="text-accent-400" />
                全片总览 · {shots.length} 段 · 段间自动续接（第 1 段起，后续段 latent 续接）
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {shots.map((shot, i) => {
                  const s = segOf(shot)
                  const active = selectedShot?.id === shot.id
                  return (
                    <button
                      key={shot.id}
                      onClick={() => setSelectedShotId(shot.id)}
                      className={`min-w-[150px] shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                        active ? 'border-accent-500 bg-accent-600/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className={active ? 'text-accent-300' : 'text-slate-400'}>第 {i + 1} 段</span>
                        <ShotStatusBadge status={shot.status} />
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {s.durationSec}s · {s.width}×{s.height}
                      </div>
                      <div className="text-[11px] text-slate-600">
                        {s.frames} 帧{s.contMode !== 'none' ? ' · 续接' : ' · 不续接'}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 段列表 */}
            <div className="space-y-3">
              {shots.map((shot, i) => {
                const s = segOf(shot)
                const cover = shot.assetIds.map((id) => project.assets.find((a) => a.id === id)?.coverFile).find(Boolean) ?? null
                return (
                  <div
                    key={shot.id}
                    className={`panel p-4 ${selectedShot?.id === shot.id ? 'border-accent/40' : ''}`}
                    onClick={() => setSelectedShotId(shot.id)}
                  >
                    <div className="flex gap-4">
                      <div className="h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-white/5 bg-ink-800">
                        <MediaImage
                          src={cover}
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
                          <span className="text-sm font-semibold text-white">第 {i + 1} 段</span>
                          <span className="truncate text-sm text-slate-300">{shot.title}</span>
                          <ShotStatusBadge status={shot.status} />
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-slate-500">{shot.description || shot.prompt}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                          <span>
                            画布 {s.width}×{s.height}（{s.ratio}）
                          </span>
                          <span>
                            时长 {s.durationSec}s · {s.fps}fps · {s.frames} 帧
                          </span>
                          <span>保留头 {s.pinHead} / 尾 {s.pinTail}</span>
                          <span>参考图 {s.refImageSize} · 视频 {s.refVideoSize}px</span>
                          <span>放大重绘 {s.upscale.enabled ? `${s.upscale.mode} ${s.upscale.mode === '倍数' ? s.upscale.scale + '×' : s.upscale.targetWidth + '×' + s.upscale.targetHeight}` : '关'}</span>
                          <span>抽帧 {s.rife.fps}fps{s.rife.enabled ? ` · 插帧 ${s.rife.multiplier}×` : ''}</span>
                          <span>语义桥 {s.bridgeMode} · {s.bridgeAlpha}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-slate-600">续接：</span>
                          {([
                            ['none', '不续接'],
                            ['latent', 'latent 续接'],
                            ['video', 'video 续接']
                          ] as const).map(([m, label]) => (
                            <button
                              key={m}
                              className={`rounded px-2 py-0.5 text-[11px] ${s.contMode === m ? 'bg-accent-600/30 text-accent-200' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                              onClick={(e) => { e.stopPropagation(); void patchSegment(shot, { contMode: m }) }}
                            >
                              {label}
                            </button>
                          ))}
                          <span className="ml-3 text-[11px] text-slate-600">生成方式：</span>
                          {([
                            ['ref2va', '参考图'],
                            ['video', '视频参考'],
                            ['t2v', '文生']
                          ] as const).map(([m, label]) => (
                            <button
                              key={m}
                              className={`rounded px-2 py-0.5 text-[11px] ${s.genMode === m ? 'bg-accent-600/30 text-accent-200' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                              onClick={(e) => { e.stopPropagation(); void patchSegment(shot, { genMode: m }) }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-2">
                        <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setParamsShotId(shot.id) }}>
                          <SlidersHorizontal size={14} />
                          段参数
                        </button>
                        <button
                          className="btn-primary"
                          disabled={!canGenerate || submittingShotId === shot.id}
                          onClick={(e) => { e.stopPropagation(); void generateOne(shot) }}
                        >
                          <Wand2 size={14} />
                          {submittingShotId === shot.id ? '提交中…' : '生成本段'}
                        </button>
                      </div>
                    </div>

                    {/* 本段生成结果：多版本视频/图片预览，可选保留哪一个、删多余的 */}
                    {shot.outputs.length > 0 && (
                      <div className="mt-3 border-t border-white/5 pt-3">
                        <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                          本段成片（{shot.outputs.length} 个版本，点「保留」选定，其余可删）
                          {shot.outputs.some((o) => o.kept) && (
                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
                              已选版本将作为下一段视频参考
                            </span>
                          )}
                        </div>
                        <div className="flex gap-3 overflow-x-auto pb-1">
                          {shot.outputs.map((o) => {
                            const keptCount = shot.outputs.filter((x) => x.kept !== false).length
                            const kept = o.kept !== false && keptCount === 1
                            const isVideo = o.kind === 'video'
                            return (
                              <div
                                key={o.id}
                                className={`shrink-0 rounded-lg border p-2 ${kept ? 'border-accent-500 bg-accent-600/10' : 'border-white/10 bg-white/[0.02]'}`}
                              >
                                <div className="h-28 w-48 overflow-hidden rounded bg-black">
                                  {isVideo ? (
                                    <VideoThumb src={o.file} className="h-full w-full object-contain" />
                                  ) : (
                                    <MediaImage src={o.file} alt="" className="h-full w-full object-cover" fallback={<div className="h-full w-full bg-ink-800" />} />
                                  )}
                                </div>
                                <div className="mt-1.5 truncate text-[11px] text-slate-400" title={o.file}>
                                  {o.file.split(/[\\/]/).pop()}
                                </div>
                                <div className="mt-1.5 flex gap-1.5">
                                  <button
                                    className={`rounded px-2 py-0.5 text-[11px] ${kept ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                                    onClick={(e) => { e.stopPropagation(); void keepOutput(shot.id, o.id) }}
                                  >
                                    {kept ? '✓ 保留中' : '设为保留'}
                                  </button>
                                  <button
                                    className="rounded bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20"
                                    onClick={(e) => { e.stopPropagation(); void removeOutput(shot.id, o.id) }}
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {paramsShotId && (() => {
        const shot = project.shots.find((s) => s.id === paramsShotId)
        if (!shot) return null
        const index = shots.indexOf(shot)
        return (
          <SegmentParamsModal
            shot={shot}
            segment={index >= 0 ? segOf(shot) : defaultSegment(shot, preset, 0)}
            index={index}
            onSave={(next) => { void saveSegment(shot.id, next); setParamsShotId(null) }}
            onClose={() => setParamsShotId(null)}
          />
        )
      })()}
    </div>
  )
}

/** 段参数弹窗 */
function SegmentParamsModal({
  shot,
  segment,
  index,
  onSave,
  onClose
}: {
  shot: Shot
  segment: SegmentSettings
  index: number
  onSave: (s: SegmentSettings) => void
  onClose: () => void
}): React.JSX.Element {
  const [s, setS] = useState<SegmentSettings>({
    ...segment,
    upscale: { ...segment.upscale },
    rife: { ...segment.rife }
  })
  const set = <K extends keyof SegmentSettings>(k: K, v: SegmentSettings[K]): void => setS((p) => ({ ...p, [k]: v }))
  const setUp = <K extends keyof SegmentSettings['upscale']>(k: K, v: SegmentSettings['upscale'][K]): void =>
    setS((p) => ({ ...p, upscale: { ...p.upscale, [k]: v } }))
  const setRife = <K extends keyof SegmentSettings['rife']>(k: K, v: SegmentSettings['rife'][K]): void =>
    setS((p) => ({ ...p, rife: { ...p.rife, [k]: v } }))

  const numField = (label: string, value: number, onChange: (n: number) => void, step = 1): React.JSX.Element => (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        step={step}
        className="field"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )

  return (
    <Modal
      title={`第 ${index + 1} 段参数 · ${shot.title}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => onSave(s)}>保存段参数</button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">画布</div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">宽</label>
              <input type="number" className="field" value={s.width} onChange={(e) => { const w = Number(e.target.value) || 1; setS((p) => ({ ...p, width: w, ratio: ratioOf(w, p.height) })) }} />
            </div>
            <div>
              <label className="label">高</label>
              <input type="number" className="field" value={s.height} onChange={(e) => { const h = Number(e.target.value) || 1; setS((p) => ({ ...p, height: h, ratio: ratioOf(p.width, h) })) }} />
            </div>
            <div>
              <label className="label">比例</label>
              <input className="field" value={s.ratio} onChange={(e) => set('ratio', e.target.value)} />
            </div>
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">时长 / 帧</div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="label">时长（秒）</label>
              <input
                type="number"
                step={0.1}
                className="field"
                value={s.durationSec}
                onChange={(e) => {
                  const d = Number(e.target.value) || 0
                  setS((p) => ({ ...p, durationSec: d, frames: framesFor(d, p.fps) }))
                }}
              />
            </div>
            <div>
              <label className="label">帧率 fps</label>
              <input
                type="number"
                className="field"
                value={s.fps}
                onChange={(e) => {
                  const f = Number(e.target.value) || 24
                  setS((p) => ({ ...p, fps: f, frames: framesFor(p.durationSec, f) }))
                }}
              />
            </div>
            {numField('帧数', s.frames, (n) => set('frames', n))}
            <div>
              <label className="label">按秒重算</label>
              <button className="btn-ghost w-full" onClick={() => setS((p) => ({ ...p, frames: framesFor(p.durationSec, p.fps) }))}>
                重算帧数
              </button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {numField('保留头帧', s.pinHead, (n) => set('pinHead', n))}
            {numField('保留尾帧', s.pinTail, (n) => set('pinTail', n))}
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">参考</div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="label">图片参考尺寸</label>
              <input className="field" value={s.refImageSize} onChange={(e) => set('refImageSize', e.target.value)} placeholder="match 或像素" />
            </div>
            {numField('视频参考尺寸', s.refVideoSize, (n) => set('refVideoSize', n))}
            {numField('参考视频 fps', s.refVideoFps, (n) => set('refVideoFps', n))}
            {numField('参考档位倍数', s.refScaleHd, (n) => set('refScaleHd', n), 0.1)}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-accent-400">放大重绘</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-300">
              <input type="checkbox" className="accent-[#7c5cff]" checked={s.upscale.enabled} onChange={(e) => setUp('enabled', e.target.checked)} />
              启用
            </label>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="label">模式</label>
              <select className="field" value={s.upscale.mode} onChange={(e) => setUp('mode', e.target.value as '倍数' | '目标尺寸')}>
                <option value="倍数">按倍数</option>
                <option value="目标尺寸">目标尺寸</option>
              </select>
            </div>
            {numField('放大倍数', s.upscale.scale, (n) => setUp('scale', n), 0.1)}
            {numField('目标宽', s.upscale.targetWidth, (n) => setUp('targetWidth', n))}
            {numField('目标高', s.upscale.targetHeight, (n) => setUp('targetHeight', n))}
            {numField('重绘步数', s.upscale.steps, (n) => setUp('steps', n))}
            {numField('去噪强度', s.upscale.denoise, (n) => setUp('denoise', n), 0.05)}
            {numField('音频重绘', s.upscale.audioDenoise, (n) => setUp('audioDenoise', n), 0.05)}
            {numField('每块帧数', s.upscale.tileFrames, (n) => setUp('tileFrames', n))}
            {numField('重叠帧数', s.upscale.overlapFrames, (n) => setUp('overlapFrames', n))}
            <div>
              <label className="label">采样器</label>
              <input className="field" value={s.upscale.sampler} onChange={(e) => setUp('sampler', e.target.value)} />
            </div>
            <div>
              <label className="label">调度器</label>
              <input className="field" value={s.upscale.scheduler} onChange={(e) => setUp('scheduler', e.target.value)} />
            </div>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-accent-400">抽帧 / 插帧</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-300">
              <input type="checkbox" className="accent-[#7c5cff]" checked={s.rife.enabled} onChange={(e) => setRife('enabled', e.target.checked)} />
              启用插帧
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {numField('参考视频抽帧 fps', s.rife.fps, (n) => setRife('fps', n))}
            {numField('插帧倍数', s.rife.multiplier, (n) => setRife('multiplier', n))}
            <div className="flex items-end">
              <label className="flex items-center gap-1.5 text-xs text-slate-300">
                <input type="checkbox" className="accent-[#7c5cff]" checked={s.rife.keepAudio} onChange={(e) => setRife('keepAudio', e.target.checked)} />
                保留原音
              </label>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">语义桥</div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="label">模型 / adapter</label>
              <input className="field" value={s.bridgeAdapter} onChange={(e) => set('bridgeAdapter', e.target.value)} placeholder="默认(v1)" />
            </div>
            {numField('强度', s.bridgeAlpha, (n) => set('bridgeAlpha', n), 0.1)}
            <div>
              <label className="label">范围</label>
              <select className="field" value={s.bridgeMode} onChange={(e) => set('bridgeMode', e.target.value)}>
                <option value="full">全量</option>
                <option value="head">首帧</option>
                <option value="tail">尾帧</option>
              </select>
            </div>
            {numField('节奏 pace', s.pace, (n) => set('pace', n), 0.1)}
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">生成方式</div>
          <div className="flex gap-2">
            {([
              ['ref2va', '参考图生成'],
              ['video', '视频参考'],
              ['t2v', '纯文生']
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`rounded-lg px-3 py-1.5 text-sm ${s.genMode === m ? 'bg-accent-600/30 text-accent-200 ring-1 ring-accent-500' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                onClick={() => set('genMode', m)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-slate-600">
            参考图：用分镜引用资产的绑定图；视频参考：用上一段成片当参考；纯文生：不带任何参考。
          </div>
        </section>

        <section>
          <div className="mb-2 text-xs font-medium text-accent-400">续接</div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">续接模式</label>
              <select className="field" value={s.contMode} onChange={(e) => set('contMode', e.target.value as SegmentSettings['contMode'])}>
                <option value="none">不续接</option>
                <option value="latent">latent 续接（推荐）</option>
                <option value="video">video 续接</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-1.5 text-xs text-slate-300">
                <input type="checkbox" className="accent-[#7c5cff]" checked={s.pushWhole} onChange={(e) => set('pushWhole', e.target.checked)} />
                整片潜空间发送
              </label>
            </div>
            <div className="flex items-end text-[11px] text-slate-500">
              第 1 段建议不续接；后续段 latent 续接上一段，形成连续长视频。
            </div>
          </div>
        </section>
      </div>
    </Modal>
  )
}
