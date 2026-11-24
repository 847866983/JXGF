/**
 * 镜序工坊 共享领域模型。
 * 主进程与渲染进程共用同一套类型，保证「逻辑清楚」：
 * Project -> Script -> Episode -> Scene -> Shot，资产全局共享。
 */

export type AssetKind = 'character' | 'scene' | 'prop'

export interface AssetVersion {
  id: string
  file: string
  mime: string
  createdAt: string
}

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  alias?: string
  tags: string[]
  description: string
  prompt: string
  negative: string
  coverFile: string | null
  images: string[]
  versions: AssetVersion[]
  createdAt: string
  updatedAt: string
}

export type ScriptStatus = 'idea' | 'writing' | 'ready'

export interface Script {
  id: string
  index: number
  name: string
  createdAt: string
}

// ---------- 工作流节点包：节点级参数（B 类）----------
// 这些参数直接映射到工作流里 节点包节点的 widget 字段。
// 字段名与 ComfyUI 节点 INPUT_TYPES 逐字对齐（见注入层 applyNodeParams）。
// 按「全片一份」挂在 Episode 上：SLA / 显存 / Sigma / 预览 / 视频合成 / RTX
// 都是工作流级设置，不属于某一段。

/** BanZhang_SLABlockSparseAttention 稀疏注意力 */
export interface SlaParams {
  /** 关闭=省多少计算写 0（节点仍执行但不减计算） */
  enabled: boolean
  /** 省多少计算 0–95（越大越快、细节略降） */
  saveCompute: number
  /** 开头几步不省 0–8 */
  skipFirstSteps: number
  /** 最后几步精修 0–8 */
  refineLastSteps: number
  /** 保住声音 */
  keepAudio: boolean
  /** 参考声音保多少 0–65536 */
  audioRefKeep: number
  /** 计算块大小 */
  blockSize: '64' | '128'
}

/** BanZhang_H3MemoryOptimizer 显存优化 */
export interface MemOptimizerParams {
  /** 省显存档位（档位名与节点下拉逐字一致） */
  preset: string
  /** 前馈分块 1–64 */
  feedforwardChunk: number
  /** 分块触发长度 256–262144 */
  chunkThreshold: number
  /** 注意力头分组 1–56 */
  headGroup: number
}

/** BanZhang_SelfLiftMultiStage 多级放大 */
export interface SelfLiftParams {
  /** 分段步数，如 "3,3" */
  steps: string
  /** 级间倍率，如 "1.5" */
  scale: string
  /** latent 放大模型文件名 */
  model: string
  /** 满分辨率分块 */
  tiling: string
  /** 彩色光点清理力度 6–12 */
  cleanup: number
  /** 省显存模式 spatial/global_stream/global/global_ram */
  memMode: string
  /** token 分块大小 128–16384 */
  tokenChunk: number
  /** 权重缓存预算 0–64 */
  weightCache: number
}

/** MiniMaxH3SigmaShift Sigma 位移 */
export interface SigmaParams {
  /** shift_video 0.01–100 */
  shiftVideo: number
  /** shift_audio 0.01–100 */
  shiftAudio: number
}

/** MiniMaxH3PreviewOverride 预览覆盖 */
export interface PreviewParams {
  maxResolution: number
  jpegQuality: number
  suppressDefault: boolean
  previewFrames: number
  previewFps: number
  vaeName: string
}

/** banzhangVideoCombine 视频合成（超分/一采/二采/三采 四个输出共用一份配置） */
export interface VideoCombineParams {
  /** ⏱️ 帧率 */
  fps: number
  /** 📼 视频格式 */
  format: string
  /** 💾 保存元数据 */
  saveMetadata: boolean
  /** 🔔 提示音文件 */
  notifyFile: string
  /** 🧹 出片后自动净化 */
  cleanAfter: boolean
  /** 📂 自定义保存路径 */
  customPath: string
}

/** BanZhang_RTX_SuperResolution RTX 超分 */
export interface RtxParams {
  scaleMode: string
  scale: number
  width: number
  height: number
  preset: string
  strength: number
  precision: string
  fps: number
  packVideo: boolean
  keepAudio: boolean
}

/** BanZhang_VRAM_Guard / VRAM_Cleaner 显存守卫与净化 */
export interface VramParams {
  /** 预留容量_GB */
  guardGB: number
  /** 卸载模型 */
  cleanerUnload: boolean
  /** 清理缓存 */
  cleanerCache: boolean
}

/** BanZhang_LoRA_VramSafe 的单个 LoRA 槽 */
export interface LoraSlot {
  on: boolean
  file: string
  strength: number
  note?: string
}

/** 全片级的 节点包节点参数集合 */
export interface NodeParams {
  sla?: SlaParams
  memOpt?: MemOptimizerParams
  selfLift?: SelfLiftParams
  sigma?: SigmaParams
  preview?: PreviewParams
  videoCombine?: VideoCombineParams
  rtx?: RtxParams
  vram?: VramParams
  /** LoRA 多挂载面板（写进 LoRA配置 JSON） */
  loraSlots?: LoraSlot[]
  /** MMH3_UpscaleParams：放大时间分块 */
  upscaleTimeChunk?: string
  /** MMH3_UpscaleParams：预显影步数 */
  preDecodeSteps?: number
  /** MMH3_UpscaleParams：预显影强度 */
  preDecodeStrength?: number
}

export interface Episode {
  id: string
  scriptId: string
  index: number
  title: string
  summary: string
  status: ScriptStatus
  /**
   * 文案台「片子级」提示词：全片统一的风格 / 基调 / 世界观。
   * 生成每一段时都拼在本段提示词**前面**（对应 H3 文案台的 compose_text）。
   */
  globalPrompt?: string
  stages?: { first: boolean; second: boolean; third: boolean; superRes: boolean }
  sampler?: { steps?: number; cfg?: number; sampler?: string; scheduler?: string }
  /** 每个阶段各自的采样参数（一采/二采/三采/超分） */
  stageParams?: Partial<Record<'first' | 'second' | 'third' | 'superRes', { steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number }>>
  /** 文案台 presets 快捷短语（点一下追加到当前段提示词） */
  presets?: string[]
  /** 时间轴「推送整片」：把已生成的整片作为视频参考传给后续段 */
  wholeFilmAsRef?: boolean
  /** 工作流节点包节点级参数（全片一份） */
  nodeParams?: NodeParams
}

export interface Scene {
  id: string
  episodeId: string
  index: number
  title: string
  location: string
  time: string
  summary: string
}

export type ShotStatus = 'draft' | 'ready' | 'generating' | 'done' | 'failed'
export type OutputKind = 'video' | 'image'

export interface ShotOutput {
  id: string
  file: string
  kind: OutputKind
  /** 是否保留（false=弃用；多版本里只保留一个"角色/成片"版本） */
  kept?: boolean
  promptId?: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  error?: string
  createdAt: string
}

/** 放大重绘参数（映射 BanZhang_MMH3_Upscale / UpscaleParams） */
export interface UpscaleSettings {
  enabled: boolean
  mode: '倍数' | '目标尺寸'
  scale: number
  targetWidth: number
  targetHeight: number
  steps: number
  denoise: number
  audioDenoise: number
  sampler: string
  scheduler: string
  tileFrames: number
  overlapFrames: number
}

/** 抽帧 / 插帧参数（映射 ref_video_fps 与 BanZhang_RIFE_Interpolation） */
export interface RifeSettings {
  enabled: boolean
  /** 参考视频抽帧 fps（24 = 不抽帧） */
  fps: number
  /** 插帧倍数 */
  multiplier: number
  keepAudio: boolean
}

/** 分段导演台：单个分镜（段）的 H3 参数（映射 CSGlideCastCS.h3_data） */
export interface SegmentSettings {
  /** 画布 */
  width: number
  height: number
  ratio: string
  /** 时长 / 帧 */
  durationSec: number
  fps: number
  frames: number
  /** 保留头 / 尾帧 */
  pinHead: number
  pinTail: number
  /** 参考 */
  refImageSize: string
  refVideoSize: number
  refVideoFps: number
  refScaleHd: number
  /** 语义桥 */
  bridgeAdapter: string
  bridgeAlpha: number
  bridgeMode: string
  pace: number
  /** 续接 */
  contMode: 'latent' | 'video' | 'none'
  /**
   * 生成阶段开关：一采 / 二采 / 三采 / 超分。
   * 只开一采时就只取一采的产物，不再等后面几次采样。
   */
  stages?: { first: boolean; second: boolean; third: boolean; superRes: boolean }
  /**
   * 承接帧数：从上一段**尾部**取几帧，钉在本段开头当引导（H3 导演台的
   * 「承接帧数」）。只接受 17k+5 网格：5 / 22 / 39 / 56 / 73 …
   * 0 = 独立成段（不承接）。默认 22。
   * 这是 latent 续接的总开关 —— 不是 5 也不是 20，20 不在网格上。
   */
  contFrames?: number
  pushWhole: boolean
  /** 本段生成方式：ref2va=参考图生成，video=参考视频生成，t2v=纯文生 */
  genMode: 'ref2va' | 'video' | 't2v'
  /** 放大重绘 */
  upscale: UpscaleSettings
  /** 抽帧 / 插帧 */
  rife: RifeSettings
  /**
   * 文案台：本段的提示词预设标签（点一下追加到本段提示词末尾）。
   * 对应 H3 Studio 文案台里的「镜头缓慢推进…」等可点标签。
   */
  presets?: string[]
  /**
   * 文案台：别名模式开关。
   * 开启后提示词里写的资产名/角色名会被 H3 自动展开成 @图片N 引用；
   * 关闭则只认显式写的 @图片N。
   */
  aliasMode?: boolean
}

export interface Shot {
  id: string
  sceneId: string
  index: number
  title: string
  description: string
  dialogue: string
  camera: string
  duration: number
  /** 视频生成提示词（详细版，用于 H3 视频生成；区别于简短的 description） */
  prompt: string
  characterIds: string[]
  assetIds: string[]
  /** 本镜内各角色的位置/动作说明（资产 id -> 描述），如「屏幕左上，正伸手抓取」 */
  characterNotes?: Record<string, string>
  /** 分段导演台：本段（分镜）的 H3 参数 */
  segment?: SegmentSettings
  refImage: string | null
  status: ShotStatus
  outputs: ShotOutput[]
  createdAt: string
  updatedAt: string
}

export interface TemplateMapping {
  version: number
  positive?: string | number
  negative?: string | number
  seed?: string | number
  width?: string | number
  height?: string | number
  frames?: string | number
  [key: string]: unknown
}

export interface Template {
  id: string
  name: string
  kind: OutputKind
  description?: string
  sourceFile?: string
  nodeCount?: number
  apiJson: unknown
  mapping: TemplateMapping
  createdAt: string
}

export interface ComfySettings {
  host: string
  port: number
  protocol: 'http' | 'https'
}

export interface ProjectSettings {
  comfy: ComfySettings
  aspect: string
  style: string
  autoRetry: number
  retryDelaySec: number
  activeScriptId: string | null
  /** 导演台当前选中的剧集 id（跨页面切换保持） */
  activeEpisodeId?: string | null
  presetId: string
}

/** AI 助手的单条对话消息（随项目一起持久化） */
export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
}

export interface Project {
  schema: number
  id: string
  name: string
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  scripts: Script[]
  episodes: Episode[]
  scenes: Scene[]
  shots: Shot[]
  assets: Asset[]
  templates: Template[]
  /** AI 助手对话历史，旧项目缺省时按空数组处理 */
  aiChat?: AiChatMessage[]
  /** 运行时乐观锁版本号：主进程每次写入 current 递增，渲染层保存时校验，防止旧快照覆盖后台写回的产物。不参与业务语义。 */
  rev?: number
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  createdAt: string
  assetCount: number
  shotCount: number
  scriptCount: number
}

// ---------- 硬件与档位 ----------

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown'

export interface GpuInfo {
  vendor: GpuVendor
  name: string
  vramMB: number
  vramKnown: boolean
  driver: string
  cudaAvailable: boolean
  raw: string
}

export interface GenerationPreset {
  id: string
  label: string
  minVramMB: number
  maxVramMB: number | null
  video: {
    width: number
    height: number
    frames: number
    fps: number
    passes: number
    lowvram: boolean
    quantized: boolean
  }
  image: { width: number; height: number }
  note: string
}

export interface HardwareReport {
  gpu: GpuInfo
  preset: GenerationPreset
  comfyMode: 'local-full' | 'local-image' | 'remote'
  recommendations: string[]
  detectedAt: string
}

// ---------- ComfyUI ----------

export interface ComfySystemStats {
  online: boolean
  version: string
  gpu?: { name?: string; vramTotal?: number; vramFree?: number } | null
  ram?: { total?: number; free?: number } | null
  cpuAvailable: boolean
  queueRemaining: number
  queueRunning: number
  raw?: Record<string, unknown>
}

// ---------- 任务 ----------

export interface JobParams {
  projectId: string
  shotId?: string
  assetId?: string
  templateId: string
  positive?: string
  /** 片子级提示词（文案台 global）；为空则只用本段提示词 */
  globalPrompt?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
  /** 每批生成张数（资产多图生成用） */
  batch?: number
  /** 采样器细参 */
  steps?: number
  cfg?: number
  samplerName?: string
  scheduler?: string
  /** 各阶段采样参数 */
  stageParams?: Partial<Record<'first' | 'second' | 'third' | 'superRes', { steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number }>>
  /** 生成阶段开关（一采/二采/三采/超分） */
  stages?: { first: boolean; second: boolean; third: boolean; superRes: boolean }
  /** 分段导演台：H3 h3_data 覆盖字段（画布/参考/语义桥/续接等） */
  h3?: Record<string, unknown>
  /** 放大重绘 */
  upscale?: UpscaleSettings
  /** 抽帧 / 插帧 */
  rife?: RifeSettings
  refImages?: string[]
  /**
   * 参考图对应的称呼（通常传资产名）。
   * H3 会把槽位 alias 与提示词里的称呼做匹配，写进 alias 后提示词写角色名即可绑定参考图。
   */
  refAliases?: string[]
  /** 需要挂载的 LoRA（如千问多角度四视图） */
  loras?: { file: string; strength: number }[]
  /** 参考视频（本段生成方式=视频参考时，传上一段成片） */
  refVideos?: string[]
  /** 工作流节点包节点级参数（SLA/显存/Sigma/预览/视频合成/RTX/LoRA 等） */
  nodeParams?: NodeParams
  /** 文案台快捷短语 */
  presets?: string[]
  assetImageIds?: string[]
}

/** 各生成阶段的采样器/调度器可选清单（来自本机 ComfyUI object_info 的真实白名单） */
export interface StageSamplerOptions {
  samplers: string[]
  schedulers: string[]
}
export type StageSamplerOptionsMap = Record<'first' | 'second' | 'third' | 'superRes', StageSamplerOptions>

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export interface JobInfo {
  id: string
  kind: OutputKind
  status: JobStatus
  progress: number
  promptId?: string
  shotId?: string
  outputs: { file: string; kind: OutputKind }[]
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

// ---------- 更新 ----------

export interface UpdateInfo {
  available: boolean
  /** 本机真实当前版本（永远取 app.getVersion()） */
  currentVersion?: string
  /** 远端最新版本（仅在发现更新时才有意义） */
  version?: string
  releaseName?: string
  releaseNotes?: string
  percent?: number
  downloaded?: boolean
  error?: string
}

// ---------- 组件目录 ----------

export interface CatalogFileSource {
  name: string
  url: string
}

export interface CatalogPackFile {
  file: string
  sizeMB?: number
  url: string
  sources: CatalogFileSource[]
  dest: string
  installed: boolean
}

export interface CatalogItem {
  id: string
  label: string
  kind: 'comfyui' | 'tool' | 'pack'
  description: string
  sizeMB?: number
  /** 工作流包：多文件清单 */
  files?: CatalogPackFile[]
  /** 单文件条目 */
  file?: string
  sources?: CatalogFileSource[]
  dest?: string
  installed: boolean
  extractedDir?: string
  extracted?: boolean
  extract?: boolean
}

// ---------- 内置 ComfyUI 运行管理 ----------

export type ComfyRuntimeStatus = 'missing' | 'installed' | 'starting' | 'running' | 'stopped' | 'error'

export interface ComfyRuntimeConfig {
  /** ComfyUI 根目录（含 main.py；便携版则是含 ComfyUI/ 子目录的那层） */
  root: string | null
  port: number
  /** 可选：显式指定 python.exe；缺省自动探测 */
  python: string | null
}

export interface ComfyRuntimeState {
  status: ComfyRuntimeStatus
  root: string | null
  port: number
  pid: number | null
  logTail: string
  error?: string
}
