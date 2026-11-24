import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Film, ImageIcon, Link2, PenLine, Play, Save, SlidersHorizontal, Sparkles, Wand2 } from 'lucide-react'
import type { Shot, Template, SegmentSettings, StageSamplerOptionsMap } from '@shared/types'
import { DESK_PRESETS } from '@shared/node-params'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { NoProject } from '../components/NoProject'
import { ShotStatusBadge } from '../components/badges'
import { Modal } from '../components/Modal'
import { persistProject } from '../components/mutate'
import DirectorStage from '../components/DirectorStage'
import { GenerationInfoPanel } from '../components/GenerationInfoPanel'
import { readStageDefaults } from '../lib/stageDefaults'
import NodeParamsPanel from '../components/NodeParamsPanel'
import { alignFrames, defaultSegment, framesFor, getSegment, ratioOf } from '../lib/segment'
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

/** 导演台默认模板：优先用户所选；否则优先 H3/MiniMax/节点包视频模板；再退其它视频/首个 */
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
  const loadHardware = useApp((s) => s.loadHardware)
  const pushNotice = useApp((s) => s.pushNotice)

  // 导演台可能被直接打开（没经过仪表盘），这里自己补一次硬件检测；
  // 否则 preset 为 null → canGenerate=false → 「生成本段」按钮是禁用的，
  // 点下去完全没反应。
  useEffect(() => {
    if (!useApp.getState().hardware) void loadHardware()
  }, [loadHardware])
  const navigate = useNavigate()
  // 剧本分镜已整合进导演台，外部入口（仪表盘快捷按钮 / 旧 /storyboard 链接）
  // 通过 ?tab=storyboard 直接打开对应页签
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab')
  const validTab = initialTab === 'storyboard' || initialTab === 'generation' ? initialTab : 'segment'

  const [episodeId, setEpisodeId] = useState('')
  // 剧集选择跨页面保持：切到生成队列会卸载本组件，局部 state 归零；
  // 这里从项目 settings.activeEpisodeId 恢复，只初始化一次，不覆盖用户后续切换。
  const episodeInitRef = useRef(false)
  useEffect(() => {
    if (episodeInitRef.current || !project) return
    const saved = project.settings.activeEpisodeId
    if (saved && project.episodes.some((e) => e.id === saved)) {
      episodeInitRef.current = true
      setEpisodeId(saved)
    } else if (project.episodes.length > 0) {
      episodeInitRef.current = true // 无保存值，保持 '' → 回退第一集
    }
  }, [project])

  /** 切换剧集：同步更新局部 state 并持久化，供下次回到导演台恢复 */
  const selectEpisode = (id: string): void => {
    setEpisodeId(id)
    episodeInitRef.current = true
    void persistProject((draft) => {
      draft.settings.activeEpisodeId = id
    })
  }
  // 采样器/调度器白名单（来自本机 ComfyUI object_info）：生成信息页下拉用；离线时为 null → 手填输入框。
  // ⚠️ hooks 必须放在组件顶部所有提前 return 之前——下面 storyboard/无项目分支会提前 return，
  // 若 hooks 在其后，切 tab 时 hooks 数量前后不一致会直接崩掉整页（"Rendered fewer hooks than expected"）。
  const [tab, setTab] = useState<'segment' | 'storyboard' | 'generation'>(validTab)
  const [stageSamplerOptions, setStageSamplerOptions] = useState<StageSamplerOptionsMap | null>(null)
  useEffect(() => {
    if (tab !== 'generation') return
    void window.api
      .comfyStageSamplers()
      .then(setStageSamplerOptions)
      .catch(() => setStageSamplerOptions(null))
  }, [tab])
  const [nodeParamsOpen, setNodeParamsOpen] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [selectedShotId, setSelectedShotId] = useState('')
  const [paramsShotId, setParamsShotId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [submittingShotId, setSubmittingShotId] = useState<string | null>(null)
  /** 生成前校验错误（如参考图缺失），显示在页面顶部提示 */
  const [error, setError] = useState<string | null>(null)
  /** 提交成功回执（绿色提示，几秒后自动消失） */
  const [notice, setNotice] = useState<string | null>(null)
  /** Toast 出口：保留原 state（兼容旧流程），展示统一改由全局通知中心（右上角 Toast）完成 */
  const showError = (t: string | null): void => {
    setError(t)
    if (t) pushNotice('danger', t)
  }
  const showNotice = (t: string | null): void => {
    setNotice(t)
    if (t) pushNotice(t.startsWith('还没有') ? 'warn' : 'ok', t)
  }
  /** 导演台内直接编辑本段提示词的草稿（按分镜 id 存），未保存时 dirty */
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({})
  const [promptDirty, setPromptDirty] = useState(false)
  /** 文案台「片子级提示词」草稿：null = 跟随当前剧集（未编辑过） */
  const [globalPromptDraft, setGlobalPromptDraft] = useState<string | null>(null)
  const [globalDirty, setGlobalDirty] = useState(false)
  /** 片子级提示词区是否展开 */
  const [globalOpen, setGlobalOpen] = useState(false)
  /** 右栏分页：文案 / 段参数 / 剧本 */
  const [rightTab, setRightTab] = useState<'prompt' | 'params' | 'meta'>('prompt')
  /** 文案台「AI 改写」进行中 */
  const [rewriting, setRewriting] = useState(false)
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
      <button className={tab === 'generation' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('generation')}>
        生成信息
      </button>
      <button className="btn-ghost" onClick={() => setNodeParamsOpen(true)} title="SLA / 显存 / Sigma / 视频合成 / RTX / LoRA 等底层节点参数">
        节点参数
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] text-slate-600">工作流</span>
        <select
          className="field py-1 text-[11px]"
          value={templateId || pickDirectorTemplate(project?.templates ?? [], '')?.id || ''}
          onChange={(e) => setTemplateId(e.target.value)}
          title="切换生成用的工作流模板（导入的其他功能域模板也在这里）"
        >
          {(project?.templates ?? []).filter((t) => t.kind === 'video' || /H3|MiniMax|视频|video/i.test(t.name)).map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
          {(project?.templates.length ?? 0) === 0 && <option value="">（无模板）</option>}
        </select>
      </div>
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

  /** 片子级提示词：编辑过就用草稿，否则跟随剧集里存的那份 */
  // —— 生成信息（全片统一，作用于所有分段）——
  const globalStages = selectedEpisode.stages ?? { first: true, second: true, third: true, superRes: false }
  const globalSampler = selectedEpisode.sampler ?? {}
  const stageParams = selectedEpisode.stageParams ?? {}
  const saveStageParam = async (k: 'first' | 'second' | 'third' | 'superRes', patch: Record<string, unknown>): Promise<void> => {
    await persistProject((draft) => {
      const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
      if (!ep) return
      const cur = ep.stageParams?.[k] ?? {}
      ep.stageParams = { ...(ep.stageParams ?? {}), [k]: { ...cur, ...patch } }
    })
  }
  const saveGlobalStages = async (next: typeof globalStages): Promise<void> => {
    await persistProject((draft) => {
      const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
      if (ep) ep.stages = next
      // 全片开关 = 批量作用到本剧集所有段，和段级 checkbox 保持同一真相
      const epSceneIds = new Set(draft.scenes.filter((sc) => sc.episodeId === selectedEpisode.id).map((sc) => sc.id))
      for (const sh of draft.shots) {
        if (epSceneIds.has(sh.sceneId) && sh.segment) sh.segment.stages = { ...next }
      }
    })
  }
  const saveGlobalSampler = async (next: typeof globalSampler): Promise<void> => {
    await persistProject((draft) => {
      const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
      if (ep) ep.sampler = next
    })
  }

  const globalPrompt = globalPromptDraft ?? selectedEpisode.globalPrompt ?? ''

  const template = pickDirectorTemplate(project.templates, templateId)

  // 从工作流里读出每个阶段的默认采样参数（预填到输入框）
  const stageDefaults = readStageDefaults(template?.apiJson)
  // 兜底档位：硬件还没检测完也不能让生成按钮变灰
  const preset = hardware?.preset.video ?? { width: 576, height: 320, frames: 124 }
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
      // 别名模式：开启后提示词里的资产名/角色名会被 H3 展开成 @图片N
      alias: s.aliasMode !== false,
      chain: { name: chainName, clip, shot: shot.id }
    }
    // 只有潜空间续接才真正写 cont；历史遗留的 'video' 档不写（避免误导）
    // frames 必须 > 0：csglide_cast.py:2337 里 frames<=0 会直接"独立成段不承接"。
    // 只传 frames、不传 latent_file —— H3 走自动接续，从档案上一段取尾部 N 帧钉到
    // 本段开头（_video_tail_from_latent），不把上一段整段潜空间卷进来（那会撑长/翻倍）。
    if (s.contMode === 'latent') h3.cont = { mode: 'latent', frames: s.contFrames || 22 }
    return h3
  }

  const submitJob = async (shot: Shot, index: number): Promise<void> => {
    if (!template || !preset) {
      showError('还没有可用的工作流模板或生成档位 —— 请在设置里导入工作流、或先检测硬件')
      return
    }
    // 用 store 里最新项目数据（连续生成时上一段产物刚写回，闭包里的 project 是旧的）。
    // 注意：绝不在这里改写用户的段参数（帧数/时长等）——显存问题已由 ComfyUI 的
    // --lowvram 模式根治，再"自动钳制"只会悄悄改掉用户设定的创作参数。
    const liveProject = useApp.getState().project ?? project
    const liveShots = computeShots(liveProject, selectedEpisode.id)
    const targetShot = liveShots.find((x) => x.id === shot.id) ?? shot
    const s = getSegment(targetShot, preset, index)
    // 后续统一用 targetShot（来自最新 store 快照）
    shot = targetShot
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
      showError(
        `参考图缺失：分镜引用的资产（${names}）还没有生成过图片。` +
          `请先到「资产」页给这些资产生成图片（或把已有图片设为绑定图），再回来生成。` +
          `若想不用参考图直接生成，请把本段生成方式改成「纯文生」。`
      )
      return
    }
    let refVideos: string[] = []
    if (s.genMode === 'video') {
      const liveEp = liveProject.episodes.find((e) => e.id === selectedEpisode.id)
      if (liveEp?.wholeFilmAsRef) {
        // 「推送整片」开启：把时间轴上所有已生成段按顺序作为参考视频（最多取前若干段，避免超出槽位）
        const filmFiles = liveShots.flatMap((sh) =>
          (sh.outputs ?? []).filter((o) => o.kind === 'video' && o.kept !== false).map((o) => o.file)
        )
        refVideos = filmFiles.slice(0, 8)
      }
      if (refVideos.length === 0) {
        const prev = liveShots[index - 1]
        const prevVideos = (prev?.outputs ?? [])
          .filter((o) => o.kind === 'video' && o.kept !== false)
          .map((o) => o.file)
        if (prevVideos.length > 0) refVideos = [prevVideos[prevVideos.length - 1]]
      }
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

    // 潜空间续写：只写 cont.mode='latent'，让 H3 自己按档案链（chain.order/current）
    // 做「自动接续」——这正是 ComfyUI 浏览器手动跑的做法，输出正确的本段帧数。
    //
    // 【2026-11-23 根因】之前这里额外注入 latent_file + frames，导致 H3 走
    // 「从文件读整段潜空间」的路径，把上一段整段拼进输出 → 5 秒段变 10 秒（243 帧）。
    // 对比手动跑的 prompt：cont 只有 {mode:'latent', frames:0}，没有 latent_file，
    // 输出恒为 124 帧。手动画面能接上靠的是 H3 档案的自动接续，不是显式 latent_file。
    // 所以这里不再传 latent_file / frames —— 续接交给 H3 自动机制。
    const chainName = `${project.name}·${selectedEpisode.title}`
    const h3Param = buildH3(shot, index)
    if (s.contMode === 'latent' && index > 0) {
      // 只保留 mode；buildH3 已写入 h3.cont={mode:'latent'}（见 buildH3）。
      // 保留档案存在性检查用于提示，但不改变 cont 内容。
      const prev = liveShots[index - 1]
      if (prev) {
        try {
          const r = (await window.api.h3ChainCont(chainName, prev.id)) as {
            cont_path?: string
            error?: string
          }
          if (!r?.cont_path) {
            showNotice(
              `第 ${index + 1} 段是续接段，但档案里上一段还没有续拍存档` +
                `（${r?.error ?? '未找到'}）——H3 会按自动接续处理；` +
                `若上一段没跑过，本段会独立成段。`
            )
          }
        } catch {
          // 档案查询失败不影响提交：H3 自动接续照常工作
        }
      }
    }

    await window.api.jobGenerate({
      projectId: project.id,
      shotId: shot.id,
      templateId: template.id,
      positive,
      // 文案台「片子级」提示词：主进程按 片子级 + 本段 拼接后写进 h3_data.prompt
      globalPrompt,
      width: s.width,
      height: s.height,
      frames: s.frames,
      steps: globalSampler.steps || (genSteps ? num(genSteps, 0) || undefined : undefined),
      cfg: globalSampler.cfg || (genCfg ? Number(genCfg) || undefined : undefined),
      samplerName: genSampler.trim() || undefined,
      scheduler: genScheduler.trim() || undefined,
      seed: genSeed.trim() ? Number(genSeed) || undefined : undefined,
      h3: h3Param,
      // 段级「阶段」checkbox 优先（全片开关在 saveGlobalStages 时已同步写入每段，
      // 两者是同一真相；段级超分开关也必须生效，不能只看 first/second/third）
      stages: s.stages ?? globalStages,
      stageParams: stageParams,
      upscale: s.upscale,
      rife: s.rife,
      refImages: refImages.length > 0 ? refImages : undefined,
      refAliases: refAliases.length > 0 ? refAliases : undefined,
      refVideos: refVideos.length > 0 ? refVideos : undefined,
      // 节点级参数（SLA/显存/Sigma/预览/视频合成/RTX/LoRA）—— 全片一份，取自当前剧集
      nodeParams: selectedEpisode.nodeParams,
      presets: selectedEpisode.presets
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
    setSelectedShotId(shot.id) // 大窗口/时间轴跟随到本段，生成完成后成片直接贴上来
    setSubmittingShotId(shot.id)
    showError(null)
    try {
      await submitJob(shot, index)
      // 提交完**不跳转**，留在导演台继续编辑；给一条明确的提交回执
      const total = shots.length
      showNotice(`已提交第 ${index + 1}/${total} 段，正在后台生成…（可继续编辑或提交其它段）`)
      window.setTimeout(() => showNotice(null), 5000)
    } catch (err) {
      showError(`提交失败：${String((err as Error).message ?? err)}`)
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
      const hasPending = liveShots.some((s) => s.outputs.length === 0)
      // 有待生成段 → 只渲染未生成的；全部已生成 → 全部重渲染（换种子出新版本）
      const forceAll = !hasPending
      let done = 0
      let aborted = ''
      for (let i = 0; i < liveShots.length; i += 1) {
        const s = liveShots[i]
        if (!forceAll && s.outputs.length > 0) continue
        try {
          await submitJob(s, i)
        } catch (err) {
          aborted = `第 ${i + 1} 段提交失败：${String((err as Error).message ?? err)}`
          break
        }
        const result = await waitJobDone(s.id)
        if (result === 'failed' || result === 'timeout') {
          // 失败/超时后停止，避免后续段在前一段未就绪时空跑或续错潜空间
          aborted = result === 'timeout'
            ? `第 ${i + 1} 段等待超时，已停止后续段（可到「生成队列」查看）`
            : `第 ${i + 1} 段生成失败，已停止后续段（可到「生成队列」查看原因）`
          break
        }
        done += 1
      }
      if (aborted) {
        showError(aborted)
        if (done > 0) showNotice(`已完成前 ${done} 段`)
      } else {
        showNotice(forceAll ? `已提交全部 ${done} 段重渲染（新版本）` : `已提交 ${done} 段渲染`)
      }
      window.setTimeout(() => showNotice(null), 4000)
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

  /* ============ 时间轴（全片总览）工具栏/段操作 ============ */

  /** 改任意一段的段参数（时间轴的保留头尾、取消接续用） */
  const patchSegmentById = async (shotId: string, patch: Partial<SegmentSettings>): Promise<void> => {
    const live = useApp.getState().project
    const sh = live?.shots.find((x) => x.id === shotId)
    if (!sh) return
    await saveSegment(shotId, { ...segOf(sh), ...patch })
  }

  /** 重抽本段：换种子重新生成，产生新版本（旧版在「历史」里可切回） */
  const regenShot = async (shotId: string): Promise<void> => {
    const target = shots.find((s) => s.id === shotId)
    if (!target) return
    const idx = shots.indexOf(target)
    setSelectedShotId(shotId)
    setSubmittingShotId(shotId)
    showError(null)
    try {
      await submitJob(target, idx)
      showNotice(`已重抽第 ${idx + 1}/${shots.length} 段（新版本），旧版本可在「历史」里切回`)
      window.setTimeout(() => showNotice(null), 5000)
    } catch (err) {
      showError(`重抽失败：${String((err as Error).message ?? err)}`)
    } finally {
      setSubmittingShotId(null)
    }
  }

  /** 潜空间续接：把当前段末尾当作下一段开头 —— 把下一段设为 latent 续接并立即生成 */
  const continueToNext = async (shotId: string): Promise<void> => {
    const liveP = useApp.getState().project
    if (!liveP) return
    const liveShots = computeShots(liveP, selectedEpisode.id)
    const idx = liveShots.findIndex((s) => s.id === shotId)
    const next = liveShots[idx + 1]
    if (idx < 0 || !next) {
      showNotice('当前段已经是最后一段，没有可续接的下一段')
      window.setTimeout(() => showNotice(null), 4000)
      return
    }
    // 1) 把下一段设为潜空间续接（contMode=latent），用 store 快照拿它的段参数
    const nextSeg = getSegment(next, preset, idx + 1)
    await saveSegment(next.id, { ...nextSeg, contMode: 'latent' })
    setSelectedShotId(next.id)
    // 2) 立即生成下一段。submitJob 内部会重新取最新 shots 并查本段的续拍存档
    setSubmittingShotId(next.id)
    showError(null)
    try {
      await submitJob(next, idx + 1)
      showNotice(`已把第 ${idx + 1} 段末尾接到第 ${idx + 2} 段开头，正在潜空间续接生成…`)
      window.setTimeout(() => showNotice(null), 5000)
    } catch (err) {
      showError(`续接生成失败：${String((err as Error).message ?? err)}`)
    } finally {
      setSubmittingShotId(null)
    }
  }

  /** 接一段：往当前剧集末尾追加一个新分镜，并选中它 */
  const appendShot = async (): Promise<void> => {
    let newId = ''
    await persistProject((draft) => {
      // 取该剧集下的场景；没有就先建一个
      let scene = draft.scenes
        .filter((sc) => sc.episodeId === selectedEpisode.id)
        .sort((a, b) => a.index - b.index)[0]
      if (!scene) {
        scene = {
          id: crypto.randomUUID(), episodeId: selectedEpisode.id,
          index: 1, title: '场景 1', location: '', time: '', summary: ''
        }
        draft.scenes.push(scene)
      }
      const siblings = draft.shots.filter((s) => s.sceneId === scene!.id)
      const index = siblings.length ? Math.max(...siblings.map((s) => s.index)) + 1 : 1
      const now = new Date().toISOString()
      const shot: Shot = {
        id: crypto.randomUUID(), sceneId: scene.id, index,
        title: `分镜 ${index}`, description: '', dialogue: '', camera: '', duration: 5,
        prompt: '', characterIds: [], assetIds: [], refImage: null,
        status: 'draft', outputs: [], createdAt: now, updatedAt: now
      }
      draft.shots.push(shot)
      newId = shot.id
    })
    if (newId) {
      setSelectedShotId(newId)
      showNotice('已接一段 —— 在右侧写好提示词后点「生成本段」')
      window.setTimeout(() => showNotice(null), 4000)
    }
  }

  /** 导出成片：把某段的成片另存到本地 */
  const exportFilm = async (file: string, name: string): Promise<void> => {
    try {
      const r = await window.api.filmExport(file, `镜序工坊_${project.name}_${name}`)
      if (r.cancelled) return
      if (r.ok) {
        showNotice(`成片已导出：${r.outPath}`)
        window.setTimeout(() => showNotice(null), 6000)
      } else if (r.error) {
        showError(`导出失败：${r.error}`)
      }
    } catch (err) {
      showError(`导出失败：${String((err as Error).message ?? err)}`)
    }
  }

  /** 推送整片：把已拼接整片登记为剧集级视频参考，供后续段使用 */
  const pushWhole = async (): Promise<void> => {
    const live = useApp.getState().project
    const liveShots = live ? computeShots(live, selectedEpisode.id) : shots
    const hasFilm = liveShots.some((s) => s.outputs.some((o) => o.kind === 'video' && o.kept !== false))
    if (!hasFilm) {
      showNotice('还没有可推送的成片 —— 先生成至少一段')
      window.setTimeout(() => showNotice(null), 4000)
      return
    }
    await persistProject((draft) => {
      const ep = draft.episodes.find((e) => e.id === selectedEpisode.id)
      if (ep) ep.wholeFilmAsRef = true
    })
    showNotice('已把拼接整片设为视频参考（后续段生成时会带上整片）')
    window.setTimeout(() => showNotice(null), 5000)
  }

  /**
   * 文案台「立即改写」：把本段提示词喂给已配置的 AI，按 H3 官方六段规范重写。
   * 对齐工作流节点包的 REWRITE_SYSTEM_OFFICIAL（精简版）：六段固定顺序、@标签逐字保留。
   * 改写只改**文字**，不动任何画布/采样参数。
   */
  const rewritePrompt = async (shot: Shot): Promise<void> => {
    const cur = (promptDraft[shot.id] ?? shot.prompt ?? '').trim()
    if (!cur) {
      showError('本段还没有提示词，先写几句再改写')
      return
    }
    setRewriting(true)
    showError(null)
    try {
      const names = shot.assetIds
        .map((id) => project.assets.find((a) => a.id === id)?.name ?? '')
        .filter(Boolean)
      const refList = names.length
        ? names.map((n, i) => `@图片${i + 1} = ${n}`).join('\n')
        : '（本段没有参考素材）'
      const guide = [
        '你是 MiniMax H3 视频提示词改写器。只输出改写后的提示词正文，不要解释、不要代码块。',
        '【输出语言】简体中文；对白、歌词、画面可见文字保留原语言。',
        '【必须只输出这六段，按序，段名照抄】',
        'subject_definitions：每个被引用内容一项一行——标签、是什么、要保留的特征',
        'summary：一句话概括目标视频与引用关系，以 [任务类型] 开头（reference generation / keyframe completion / video continuation / video editing / audio reuse / audio reference，可组合用 +）',
        'retention_analysis：每个标签一行，说明保留/转移/复用方式',
        'detailed_description：逐镜描述画面、动作、光影、运镜、声音、对白',
        'overall_soundscape：全片环境底噪与物件实声',
        'non_diegetic_music：只有观众听得见的配乐（无则写「无」）',
        '【引用标签】@图片N / @视频N / @音频N / @视频音频N 必须逐字保留，不得增删、不得改编号；编号含义六段一致。',
        '【可用引用】',
        refList
      ].join('\n')
      const res = (await window.api.aiChat({
        messages: [{ role: 'user', content: `${guide}\n\n【待改写提示词】\n${cur}` }]
      })) as { content?: string }
      const next = (res?.content ?? '').trim()
      if (!next) throw new Error('AI 没有返回内容')
      setPromptDraft((d) => ({ ...d, [shot.id]: next }))
      setPromptDirty(true)
    } catch (err) {
      showError(`AI 改写失败：${String((err as Error).message ?? err)}`)
    } finally {
      setRewriting(false)
    }
  }

  /** 保存文案台的「片子级提示词」到当前剧集（全片共用一份） */
  const saveGlobalPrompt = async (): Promise<void> => {
    const text = globalPrompt
    await persistProject((draft) => {
      const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
      if (ep) ep.globalPrompt = text
    })
    setGlobalPromptDraft(text)
    setGlobalDirty(false)
  }

  /** 保存文案台快捷短语到当前剧集（全片共用一份） */
  const savePresets = (list: string[]): void => {
    void persistProject((draft) => {
      const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
      if (ep) ep.presets = list
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

  /** 删除某个产物版本（至少保留一个；删掉当前版本时自动切到剩下的第一个） */
  const removeOutput = async (shotId: string, outputId: string): Promise<void> => {
    const shot = project.shots.find((s) => s.id === shotId)
    const output = shot?.outputs.find((o) => o.id === outputId)
    // 至少保留一个版本：只剩一个时不删
    if (!shot || shot.outputs.length <= 1) return
    await persistProject((draft) => {
      const sh = draft.shots.find((x) => x.id === shotId)
      if (!sh || sh.outputs.length <= 1) return
      const wasKept = sh.outputs.find((o) => o.id === outputId)?.kept !== false
      sh.outputs = sh.outputs.filter((o) => o.id !== outputId)
      // 删的是当前版本 → 把剩下的第一个设为当前，保证每段始终有 KEEP
      if (wasKept && sh.outputs.length > 0) {
        for (let i = 0; i < sh.outputs.length; i++) sh.outputs[i].kept = i === 0
      }
      sh.updatedAt = new Date().toISOString()
    })
    // 清理磁盘文件（主进程先扫描所有工程确认无引用才物理删除）
    if (output?.file) void window.api.mediaDeleteFile(output.file)
  }

  /** 无缝整片：让 H3 把所有段拼成一个视频，转成 data URL 交给播放器单文件播放。
   *  这样播放时没有段间切换，彻底无卡顿。失败返回 null，播放器退回分段模式。 */
  const requestWholeFilm = async (): Promise<string | null> => {
    const name = `${project.name}·${selectedEpisode.title}`
    try {
      const r = await window.api.cglideExportWholeFilm(name)
      if (!r?.ok || !r.path) return null
      const url = await window.api.mediaDataUrl(r.path)
      return url ?? null
    } catch {
      return null
    }
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

  /** 节点级参数弹窗（生成信息页 / 分段导演页共用） */
  const nodeParamsModal = nodeParamsOpen ? (
    <NodeParamsPanel
      initial={selectedEpisode.nodeParams}
      loraFiles={[]}
      onSave={(np) => {
        void persistProject((draft) => {
          const ep = draft.episodes.find((x) => x.id === selectedEpisode.id)
          if (ep) ep.nodeParams = np
        })
        showNotice('节点参数已保存，下次生成生效')
        setNodeParamsOpen(false)
      }}
      onClose={() => setNodeParamsOpen(false)}
    />
  ) : null

  if (tab === 'generation') {
    return (
      <div>
        {tabBar}
        {nodeParamsModal}
        <PageHeader
          title="生成信息"
          desc="全片统一的生成阶段与采样参数"
          crumbs={[project.name, '导演台']}
          actions={
            <button className="btn-ghost" onClick={() => setNodeParamsOpen(true)}>
              <SlidersHorizontal size={13} className="mr-1 inline" />节点级参数
            </button>
          }
        />
        <div className="px-8 pb-8">
          <GenerationInfoPanel
            stages={globalStages}
            stageParams={stageParams}
            defaults={stageDefaults}
            options={stageSamplerOptions ?? undefined}
            onToggle={(k) => void saveGlobalStages({ ...globalStages, [k]: !globalStages[k] })}
            onParam={(k, patch) => void saveStageParam(k, patch)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      {tabBar}
      {nodeParamsModal}
      <div className="px-8 pb-8 pt-5">
        {/* notice / error 展示已迁移到全局通知中心（App.tsx ToastStack），这里不再内联渲染 */}
        <DirectorStage
          projectName={project.name}
          episodes={episodes.map((e) => ({ id: e.id, title: e.title }))}
          episodeId={selectedEpisode.id}
          onEpisode={(id) => selectEpisode(id)}
          shots={shots}
          curShot={curShot}
          onSelect={(id) => setSelectedShotId(id)}
          curSeg={seg}
          onPatch={(patch) => {
            if (curShot) void patchSegment(curShot, patch)
          }}
          prompt={curPrompt}
          onPrompt={(v) => {
            if (!curShot) return
            setPromptDraft((d) => ({ ...d, [curShot.id]: v }))
            setPromptDirty(true)
          }}
          onSavePrompt={() => {
            if (curShot) void saveShotPrompt(curShot.id, curPrompt)
          }}
          onGenerateOne={() => {
            if (curShot) void generateOne(curShot)
          }}
          onGenerateAll={() => void generateAll()}
          canGenerate={canGenerate}
          batchRunning={batchRunning}
          pendingCount={pendingCount}
          globalPrompt={globalPrompt}
          onGlobalPrompt={(v) => {
            setGlobalPromptDraft(v)
            setGlobalDirty(true)
          }}
          onSaveGlobal={() => void saveGlobalPrompt()}
          presets={selectedEpisode.presets ?? [...DESK_PRESETS]}
          onPresets={savePresets}
          onOpenParams={() => setParamsShotId(curShot?.id ?? null)}
          submitting={submittingShotId === curShot?.id}
          characterNames={(curShot?.assetIds ?? [])
            .map((id) => project.assets.find((a) => a.id === id)?.name ?? '')
            .filter(Boolean)}
          refPicks={(curShot?.assetIds ?? []).map((id, i) => {
            const a = project.assets.find((x) => x.id === id)
            const tag = `@图片${i + 1}`
            const image = a?.coverFile ?? a?.images?.[a.images.length - 1] ?? null
            const name = a?.name ?? id
            // 绑定令牌 = 名字；同时兼容旧的 @图片N 写法
            const used =
              (name.trim().length > 0 && curPrompt.includes(name.trim())) ||
              new RegExp(`${tag}(?!\\d)`).test(curPrompt)
            return {
              index: i + 1,
              assetId: id,
              name,
              image,
              hasImage: Boolean(image),
              used,
            }
          })}
          availableRefAssets={project.assets
            .filter((a) => !(curShot?.assetIds ?? []).includes(a.id))
            .map((a) => ({
              id: a.id,
              name: a.name,
              image: a.coverFile ?? a.images?.[a.images.length - 1] ?? null
            }))}
          onAddRef={(assetId) => {
            if (!curShot) return
            const next = [...(curShot.assetIds ?? []), assetId]
            void persistProject((draft) => {
              const sh = draft.shots.find((x) => x.id === curShot.id)
              if (sh) {
                sh.assetIds = next
                sh.updatedAt = new Date().toISOString()
              }
            })
          }}
          onRemoveRef={(assetId) => {
            if (!curShot) return
            const next = (curShot.assetIds ?? []).filter((id) => id !== assetId)
            void persistProject((draft) => {
              const sh = draft.shots.find((x) => x.id === curShot.id)
              if (sh) {
                sh.assetIds = next
                sh.updatedAt = new Date().toISOString()
              }
            })
          }}
          aliasMode={(seg?.aliasMode ?? true) === true}
          onToggleAlias={(v) => {
            if (curShot) void patchSegment(curShot, { aliasMode: v })
          }}
          onBindRef={(name) => {
            if (!curShot) return
            // 名字令牌依赖别名模式展开 —— 绑定时自动打开，否则写了也不生效
            if (seg?.aliasMode === false) void patchSegment(curShot, { aliasMode: true })
            const token = name.trim()
            if (!token || curPrompt.includes(token)) return
            const next = `${curPrompt.trimEnd()}${curPrompt.trim() ? '\n' : ''}${token} `
            setPromptDraft((d) => ({ ...d, [curShot.id]: next }))
            setPromptDirty(true)
          }}
          onUnbindRef={(name, tag) => {
            if (!curShot) return
            const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            let next = curPrompt
              .split(new RegExp(esc(name.trim()), 'g'))
              .join('')
              .split(new RegExp(`${esc(tag)}(?!\\d)`, 'g'))
              .join('')
              .replace(/[ \t]{2,}/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
            setPromptDraft((d) => ({ ...d, [curShot.id]: next }))
            setPromptDirty(true)
          }}
          onAppendShot={() => void appendShot()}
          onExportFilm={(file, name) => void exportFilm(file, name)}
          onPushWhole={() => void pushWhole()}
          onOpenProjects={() => navigate('/')}
          onPatchSegment={(shotId, patch) => void patchSegmentById(shotId, patch)}
          onKeepTake={(shotId, outputId) => void keepOutput(shotId, outputId)}
          onDeleteTake={(shotId, outputId) => void removeOutput(shotId, outputId)}
          onRequestWholeFilm={() => requestWholeFilm()}
          onRegenShot={(shotId) => void regenShot(shotId)}
          onContinueToNext={(shotId) => void continueToNext(shotId)}
        />
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
            onSave={(next) => {
              void saveSegment(shot.id, next)
              setParamsShotId(null)
            }}
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
            <div>
              <label className="label">帧数</label>
              <input
                type="number"
                className="field"
                value={s.frames}
                onChange={(e) => {
                  const af = alignFrames(Number(e.target.value) || 0)
                  setS((p) => ({ ...p, frames: af, durationSec: Math.round(((af - 1) / p.fps) * 100) / 100 }))
                }}
              />
            </div>
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
                <option value="none">不续接（独立成段）</option>
                <option value="latent">潜空间续接（上一段尾帧 → 本段开头）</option>
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

          {/* 承接帧数：从上一段尾部取几帧钉在本段开头（H3 导演台的「承接帧数」） */}
          {s.contMode === 'latent' && (
            <div className="mt-2.5 rounded border border-white/5 bg-white/[0.02] p-2">
              <div className="flex items-center gap-2">
                <label className="label mb-0 whitespace-nowrap">承接帧数</label>
                <input
                  className="field w-20 text-xs"
                  type="number"
                  min={0}
                  step={17}
                  value={s.contFrames ?? 22}
                  onChange={(e) => set('contFrames', Math.max(0, Number(e.target.value) || 0))}
                />
                <div className="flex flex-wrap gap-1">
                  {[5, 22, 39, 56, 73, 90].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        (s.contFrames ?? 22) === n
                          ? 'border-accent-500/50 bg-accent-600/20 text-accent-300'
                          : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'
                      }`}
                      onClick={() => set('contFrames', n)}
                    >
                      {n}帧
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-1 text-[11px] text-slate-600">
                从「上一段尾部」取几帧钉在本段开头（只接受 17k+5：5/22/39/56/73…）。
                成片里这几帧会被剪掉，不会重复。0 = 独立成段。
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  )
}
