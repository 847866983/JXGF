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

export interface Episode {
  id: string
  scriptId: string
  index: number
  title: string
  summary: string
  status: ScriptStatus
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
  pushWhole: boolean
  /** 本段生成方式：ref2va=参考图生成，video=参考视频生成，t2v=纯文生 */
  genMode: 'ref2va' | 'video' | 't2v'
  /** 放大重绘 */
  upscale: UpscaleSettings
  /** 抽帧 / 插帧 */
  rife: RifeSettings
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
  presetId: string
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
  assetImageIds?: string[]
}

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

// ---------- 环境检测 ----------

export interface ModelInventory {
  checkpoints: string[]
  loras: string[]
  vaes: string[]
}

export interface FfmpegInfo {
  found: boolean
  path: string | null
  version?: string
}

export interface EnvironmentReport {
  gpu: HardwareReport
  comfy: ComfySystemStats
  models: ModelInventory
  ffmpeg: FfmpegInfo
  scannedAt: string
}

// ---------- 下载 ----------

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled'

/** 网络与镜像设置（对齐绘世启动器的 network_preference） */
export interface NetworkSettings {
  /** HTTP(S) 代理地址，如 http://127.0.0.1:7890；留空表示直连 */
  proxyAddress: string
  mirrorPypi: boolean
  mirrorGit: boolean
  mirrorHuggingface: boolean
  mirrorExtensionList: boolean
  githubAcceleration: boolean
}

export interface DownloadRequest {
  id: string
  label: string
  url: string
  dest: string
  sha256?: string
  /** 多文件打包下载（一个工作流一套模型） */
  files?: { url: string; dest: string; sha256?: string; mirrors?: string[] }[]
  /** 备用镜像地址（主源失败自动回退，单文件下载用） */
  mirrors?: string[]
  /** 并行线程数（分块下载），默认 4 */
  parallel?: number
}

export interface DownloadTask {
  id: string
  label: string
  url: string
  dest: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes: number
  percent: number
  error?: string
  startedAt?: string
  finishedAt?: string
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

export type ComfyInstallPhase = 'idle' | 'downloading' | 'extracting' | 'configuring' | 'starting' | 'done' | 'error'

export interface ComfyInstallState {
  phase: ComfyInstallPhase
  percent: number
  message: string
  error?: string
}
