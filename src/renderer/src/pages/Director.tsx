import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Film, Link2, Play, Save, SlidersHorizontal, Wand2 } from 'lucide-react'
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
  /** 导演台内直接编辑本段提示词的草稿（按分镜 id 存），未保存时 dirty */
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({})
  const [promptDirty, setPromptDirty] = useState(false)
  /** 分镜剧本信息区是否展开 */
  const [metaOpen, setMetaOpen] = useState(false)
  /**
   * 模板自带的采样参数快照。
   * 用来判断用户是否真的改过：没改就不传，让工作流模板保持作者原配
   * （例如 4 步配 SelfLift 分段步数 3,3 是刻意配的，不该被代码按 steps/2 改写成 2,2）。
   */
  const [ksDefault, setKsDefault] = useState<{ steps: number; cfg: number; sampler: string; scheduler: string } | null>(null)

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
    // 记录模板原值，提交时用于判断"用户是否改过"
    setKsDefault({
      steps: ks.steps ?? 4,
      cfg: ks.cfg ?? 1,
      sampler: ks.samplerName ?? 'euler',
      scheduler: ks.scheduler ?? 'simple'
    })
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
      // 采样参数与模板一致时标记为未改动，让工作流保留作者原配（含 SelfLift 分段步数）
      keepTemplateSampler:
        !!ksDefault &&
        num(genSteps, 0) === ksDefault.steps &&
        Number(genCfg) === ksDefault.cfg &&
        genSampler.trim() === ksDefault.sampler &&
        genScheduler.trim() === ksDefault.scheduler,
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

  /** 在导演台直接改本段视频提示词（不用再回剧本分镜页） */
  const saveShotPrompt = async (shotId: string, prompt: string): Promise<void> => {
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (!sh) return
      sh.prompt = prompt
      sh.updatedAt = new Date().toISOString()
    })
    setPromptDirty(false)
  }

  /** 导演台内直接改分镜的剧本信息（标题/描述/台词/镜头/时长） */
  const saveShotMeta = async (
    shotId: string,
    patch: { title?: string; description?: string; dialogue?: string; camera?: string; duration?: number }
  ): Promise<void> => {
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (!sh) return
      if (patch.title !== undefined) sh.title = patch.title
      if (patch.description !== undefined) sh.description = patch.description
      if (patch.dialogue !== undefined) sh.dialogue = patch.dialogue
      if (patch.camera !== undefined) sh.camera = patch.camera
      if (patch.duration !== undefined) sh.duration = patch.duration
      sh.updatedAt = new Date().toISOString()
    })
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

  // 当前段（选中段或第 1 段）：左侧监视器 + 右侧参数面板都用它
  const curShot = selectedShot ?? shots[0] ?? null
  const curIndex = curShot ? shots.indexOf(curShot) : -1
  const curSeg = curShot ? segOf(curShot) : null
  /** 当前段提示词草稿（优先未保存的编辑内容） */
  const curPrompt = curShot ? (promptDraft[curShot.id] ?? curShot.prompt ?? curShot.description ?? '') : ''
  /** 当前段的成片（保留版本优先，否则取最后一个视频） */
  const curOutput =
    curShot && curShot.outputs.length > 0
      ? (curShot.outputs.find((o) => o.kept !== false && o.kind === 'video') ??
        curShot.outputs.filter((o) => o.kind === 'video').slice(-1)[0] ??
        curShot.outputs.find((o) => o.kept !== false) ??
        curShot.outputs[curShot.outputs.length - 1])
      : null

  return (
    <div>
      {tabBar}
      <PageHeader title="导演台" desc="分段编排 · 直接改提示词 · 段间续接成长视频" crumbs={[project.name, '导演台']} />

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
            {/* ===== 上区：左成片监视器 + 右本段参数与提示词 ===== */}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4">
              {/* 左：成片监视器 */}
              <section className="panel flex flex-col p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <Film size={15} className="text-accent-400" />
                    成片监视器
                    <span className="text-[11px] font-normal text-slate-500">
                      {selectedEpisode.title} · 第 {curIndex + 1} 段 / 共 {shots.length} 段
                    </span>
                  </div>
                  <button className="text-[11px] text-slate-500 hover:text-slate-300" onClick={() => setParamsShotId(curShot?.id ?? null)}>
                    规格·参考
                  </button>
                </div>
                <div className="relative flex-1 overflow-hidden rounded-lg border border-white/5 bg-black">
                  {curOutput ? (
                    curOutput.kind === 'video' ? (
                      <VideoThumb src={curOutput.file} className="h-full w-full object-contain" />
                    ) : (
                      <MediaImage src={curOutput.file} alt="" className="h-full w-full object-contain" fallback={<div className="h-full w-full" />} />
                    )
                  ) : (
                    <div className="flex h-full min-h-[260px] w-full items-center justify-center">
                      <div className="rounded-lg bg-white/[0.06] px-4 py-2 text-xs text-slate-300">
                        段落都接好了 —— 点「生成本段」或「连续生成」出画面
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span>
                    {curOutput
                      ? `已生成 · ${curOutput.file.split(/[\\/]/).pop()}`
                      : `第 ${curIndex + 1} 段还没有成片 —— 生成一次就有了`}
                  </span>
                  {curShot && curShot.outputs.length > 1 && (
                    <span>共 {curShot.outputs.length} 个版本</span>
                  )}
                </div>

                {/* 多版本管理：选保留版本（将作为下一段视频参考）/ 删除多余 */}
                {curShot && curShot.outputs.length > 0 && (
                  <div className="mt-2 flex gap-2 overflow-x-auto border-t border-white/5 pt-2">
                    {curShot.outputs.map((o) => {
                      const keptCount = curShot.outputs.filter((x) => x.kept !== false).length
                      const kept = o.kept !== false && keptCount === 1
                      const isVideo = o.kind === 'video'
                      return (
                        <div
                          key={o.id}
                          className={`shrink-0 rounded border p-1 ${kept ? 'border-accent-500 bg-accent-600/10' : 'border-white/10 bg-white/[0.02]'}`}
                        >
                          <div className="h-12 w-20 overflow-hidden rounded bg-black">
                            {isVideo ? (
                              <VideoThumb src={o.file} className="h-full w-full object-cover" />
                            ) : (
                              <MediaImage src={o.file} alt="" className="h-full w-full object-cover" fallback={<div className="h-full w-full" />} />
                            )}
                          </div>
                          <div className="mt-1 flex gap-1">
                            <button
                              className={`rounded px-1 py-0.5 text-[9px] ${kept ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                              onClick={() => void keepOutput(curShot.id, o.id)}
                            >
                              {kept ? '✓' : '保留'}
                            </button>
                            <button
                              className="rounded bg-rose-500/10 px-1 py-0.5 text-[9px] text-rose-300 hover:bg-rose-500/20"
                              onClick={() => void removeOutput(curShot.id, o.id)}
                            >
                              删
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* 右：本段参数 + 视频提示词 */}
              <section className="panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-medium text-white">第 {curIndex + 1} 段</div>
                  <div className="flex items-center gap-2">
                    <ShotStatusBadge status={curShot?.status ?? 'pending'} />
                    <button className="btn-ghost" onClick={() => setParamsShotId(curShot?.id ?? null)}>
                      <SlidersHorizontal size={13} />
                      段参数
                    </button>
                  </div>
                </div>

                {/* 画布 / 时长 / 参考 / 放大 / 抽帧 / 语义桥：只读摘要，改到段参数 */}
                {curSeg && (
                  <div className="space-y-1.5 rounded-lg border border-white/5 bg-ink-950/40 p-3 text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">画布</span>
                      <span className="text-slate-300">
                        {curSeg.ratio} · {curSeg.width} × {curSeg.height}
                        <span className="ml-2 text-slate-500">{((curSeg.width * curSeg.height) / 1e6).toFixed(2)} MP</span>
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">时长</span>
                      <span className="text-slate-300">
                        {curSeg.durationSec} 秒 · {curSeg.frames} 帧 · {curSeg.fps}fps
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">生成方式</span>
                      <span className="text-slate-300">
                        {curSeg.genMode === 'ref2va' ? '参考图' : curSeg.genMode === 'video' ? '视频参考' : '纯文生'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">续接</span>
                      <span className="text-slate-300">{curSeg.contMode === 'none' ? '不续接' : `${curSeg.contMode} 续接`}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">参考图 / 视频</span>
                      <span className="text-slate-300">
                        {curSeg.refImageSize} / {curSeg.refVideoSize}px
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">放大重绘</span>
                      <span className="text-slate-300">
                        {curSeg.upscale.enabled
                          ? curSeg.upscale.mode === '倍数'
                            ? `${curSeg.upscale.scale}×`
                            : `${curSeg.upscale.targetWidth}×${curSeg.upscale.targetHeight}`
                          : '关'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">抽帧</span>
                      <span className="text-slate-300">
                        {curSeg.rife.fps}fps{curSeg.rife.enabled ? ` · 插帧 ${curSeg.rife.multiplier}×` : ' · 不抽帧'}
                      </span>
                    </div>
                  </div>
                )}

                {/* 分镜剧本信息：直接在导演台改，不用回剧本分镜页 */}
                {curShot && (
                  <div className="mt-3">
                    <button
                      className="mb-1.5 flex w-full items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-300"
                      onClick={() => setMetaOpen((v) => !v)}
                    >
                      {metaOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      分镜剧本信息
                      <span className="text-slate-600">（标题 / 描述 / 台词 / 镜头 / 时长）</span>
                    </button>
                    {metaOpen && (
                      <div className="space-y-2 rounded-lg border border-white/5 bg-ink-950/40 p-3">
                        <div>
                          <label className="label text-[10px]">标题</label>
                          <input
                            className="field text-xs"
                            defaultValue={curShot.title}
                            onBlur={(e) => {
                              if (e.target.value !== curShot.title) void saveShotMeta(curShot.id, { title: e.target.value })
                            }}
                          />
                        </div>
                        <div>
                          <label className="label text-[10px]">画面描述（剧本原文）</label>
                          <textarea
                            className="field h-16 resize-y text-xs"
                            defaultValue={curShot.description ?? ''}
                            onBlur={(e) => {
                              if (e.target.value !== (curShot.description ?? '')) {
                                void saveShotMeta(curShot.id, { description: e.target.value })
                              }
                            }}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="label text-[10px]">台词</label>
                            <textarea
                              className="field h-14 resize-y text-xs"
                              defaultValue={curShot.dialogue ?? ''}
                              onBlur={(e) => {
                                if (e.target.value !== (curShot.dialogue ?? '')) {
                                  void saveShotMeta(curShot.id, { dialogue: e.target.value })
                                }
                              }}
                            />
                          </div>
                          <div>
                            <label className="label text-[10px]">镜头</label>
                            <textarea
                              className="field h-14 resize-y text-xs"
                              defaultValue={curShot.camera ?? ''}
                              onBlur={(e) => {
                                if (e.target.value !== (curShot.camera ?? '')) {
                                  void saveShotMeta(curShot.id, { camera: e.target.value })
                                }
                              }}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="label mb-0 text-[10px]">时长（秒）</label>
                          <input
                            className="field w-24 text-xs"
                            type="number"
                            min={1}
                            max={15}
                            defaultValue={curShot.duration ?? 5}
                            onBlur={(e) => {
                              const v = Number(e.target.value)
                              if (v > 0 && v !== curShot.duration) void saveShotMeta(curShot.id, { duration: v })
                            }}
                          />
                          <span className="text-[10px] text-slate-600">改完点空白处自动保存</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 视频提示词：导演台内直接编辑 */}
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-[11px] text-slate-400">
                      视频提示词
                      <span className="ml-1 text-slate-600">（写角色名会自动绑定参考图）</span>
                    </label>
                    {promptDirty && <span className="text-[10px] text-amber-400">未保存</span>}
                  </div>
                  <textarea
                    className="field h-40 w-full resize-y font-mono text-xs leading-relaxed"
                    value={curPrompt}
                    placeholder="描述这一段的画面、人物动作、镜头运动与声音。&#10;例：安洁拉走进操纵室，转身看向主屏幕，镜头缓慢推进。"
                    onChange={(e) => {
                      if (!curShot) return
                      setPromptDraft((d) => ({ ...d, [curShot.id]: e.target.value }))
                      setPromptDirty(true)
                    }}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="btn-primary"
                      disabled={!promptDirty || !curShot}
                      onClick={() => curShot && void saveShotPrompt(curShot.id, curPrompt)}
                    >
                      <Save size={13} />
                      保存提示词
                    </button>
                    <button
                      className="btn-ghost"
                      disabled={!curShot}
                      onClick={() => {
                        if (!curShot) return
                        setPromptDraft((d) => ({ ...d, [curShot.id]: curShot.description ?? '' }))
                        setPromptDirty(true)
                      }}
                    >
                      用分镜描述
                    </button>
                    <button
                      className="btn-primary ml-auto"
                      disabled={!canGenerate || !curShot || submittingShotId === curShot?.id}
                      onClick={() => curShot && void generateOne(curShot)}
                    >
                      <Wand2 size={14} />
                      {submittingShotId === curShot?.id ? '提交中…' : '生成本段'}
                    </button>
                  </div>
                </div>

                {/* 参考图绑定情况 */}
                {curShot && curShot.assetIds.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2.5">
                    <span className="text-[11px] text-slate-600">引用资产：</span>
                    {curShot.assetIds.map((id) => {
                      const a = project.assets.find((x) => x.id === id)
                      if (!a) return null
                      const hasImg = Boolean(a.coverFile ?? a.images?.[a.images.length - 1])
                      return (
                        <span
                          key={id}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${hasImg ? 'bg-accent-600/20 text-accent-300' : 'bg-amber-500/15 text-amber-300'}`}
                          title={hasImg ? '已绑定参考图' : '该资产还没有图片，参考图不会生效'}
                        >
                          {a.name}
                          {!hasImg && ' ⚠'}
                        </span>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>

            {/* ===== 下区：全片总览时间轴 ===== */}
            <section className="panel mt-4 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Link2 size={14} className="text-accent-400" />
                  全片总览 · {shots.length} 段 · {totalSec.toFixed(1)}s
                </div>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <button className="btn-ghost" onClick={() => void generateAll()} disabled={!canGenerate || batchRunning || pendingCount === 0}>
                    <Play size={13} />
                    {batchRunning ? '生成中…' : `连续生成（${pendingCount}）`}
                  </button>
                  <button className="btn-ghost" onClick={() => setParamsOpen((v) => !v)}>
                    <SlidersHorizontal size={13} />
                    采样参数
                  </button>
                </div>
              </div>

              {paramsOpen && (
                <div className="mb-3 grid grid-cols-5 gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
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

              {/* 时间轴：每段一个可点选块 */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {shots.map((shot, i) => {
                  const s = segOf(shot)
                  const active = curShot?.id === shot.id
                  const out = shot.outputs.find((o) => o.kept !== false) ?? shot.outputs[shot.outputs.length - 1]
                  return (
                    <button
                      key={shot.id}
                      onClick={() => { setSelectedShotId(shot.id); setPromptDirty(false) }}
                      className={`group min-w-[168px] shrink-0 rounded-lg border text-left transition-colors ${
                        active ? 'border-accent-500 bg-accent-600/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between px-2.5 pt-2 text-[11px]">
                        <span className={active ? 'text-accent-300' : 'text-slate-400'}>第 {i + 1} 段</span>
                        <ShotStatusBadge status={shot.status} />
                      </div>
                      <div className="mx-2.5 mt-1.5 h-12 overflow-hidden rounded bg-black">
                        {out ? (
                          out.kind === 'video' ? (
                            <VideoThumb src={out.file} className="h-full w-full object-cover" />
                          ) : (
                            <MediaImage src={out.file} alt="" className="h-full w-full object-cover" fallback={<div className="h-full w-full" />} />
                          )
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">待生成</div>
                        )}
                      </div>
                      <div className="px-2.5 pb-2 pt-1 text-[10px] text-slate-500">
                        {s.durationSec}s · {s.frames}帧 · {s.contMode === 'none' ? '不续接' : `${s.contMode}续接`}
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                <span>
                  第 {curIndex + 1} / {shots.length} 段 · 待生成 {pendingCount} 段
                </span>
                <span>{curSeg ? `${curSeg.frames} 帧` : ''}</span>
              </div>
            </section>
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
