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
  promptId?: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  error?: string
  createdAt: string
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
  characterIds: string[]
  assetIds: string[]
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
  templateId: string
  positive?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
  refImages?: string[]
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

export interface DownloadRequest {
  id: string
  label: string
  url: string
  dest: string
  sha256?: string
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

export interface CatalogItem {
  id: string
  label: string
  kind: 'comfyui' | 'tool' | 'model'
  description: string
  sizeMB?: number
  file: string
  sources: { name: string; url: string }[]
  dest: string
  installed: boolean
  extractedDir: string
  extracted: boolean
  extract: boolean
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
