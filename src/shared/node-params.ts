/**
 * 班长全家桶节点级参数的默认值与下拉选项。
 *
 * 默认值取自 ComfyUI-Banzhang-All-1101 的 INPUT_TYPES，以及内置模板
 * `tpl_wf05.json`（minimax h3-三采-1031）里的作者原配。
 * 放在 shared 层，主进程（注入）与渲染进程（UI 表单）共用同一份口径，
 * 避免两处各写一套默认值造成漂移。
 */
import type {
  NodeParams,
  SlaParams,
  MemOptimizerParams,
  SelfLiftParams,
  SigmaParams,
  PreviewParams,
  VideoCombineParams,
  RtxParams,
  VramParams
} from './types'

// ---------- 下拉选项（与节点 INPUT_TYPES 逐字一致）----------

export const MEM_PRESETS = [
  '① 关（最快，不省显存）',
  '② 轻度（省一点，画面完全不变）',
  '③ 强力（省得多，画面基本不变）',
  '④ 自定义（用下面的参数）'
] as const

export const BLOCK_SIZES = ['64', '128'] as const

export const SELFLIFT_MEMORY_MODES = ['spatial', 'global_stream', 'global', 'global_ram'] as const
export const SELFLIFT_TILINGS = [
  '自动（按显存智能规划）',
  '关（整幅收尾）',
  '2 块（接缝最少）',
  '4 块（均衡）',
  '8 块（省显存）',
  '16 块（低显存救急）'
] as const

export const VIDEO_FORMATS = [
  'MP4 (H264/通用)',
  'MP4 (H265/高画质)',
  'MOV (H264/网页兼容)',
  'MOV (ProRes/专业剪辑)',
  'MKV (H264/防损坏)',
  'WEBM (网页/透明)',
  'GIF (动图)',
  'WEBP (动图)'
] as const

export const RTX_SCALE_MODES = ['按倍数放大', '指定输出尺寸'] as const
export const RTX_QUALITY_LEVELS = [
  '常规放大·极速',
  '常规放大·均衡',
  '常规放大·高质',
  '常规放大·极致',
  '降噪·轻度',
  '降噪·中度',
  '降噪·强力',
  '降噪·极致',
  '去模糊·轻度',
  '去模糊·中度',
  '去模糊·强力',
  '去模糊·极致',
  '高清片源·极速',
  '高清片源·均衡',
  '高清片源·高质',
  '高清片源·极致',
  '直播流·均衡',
  '直播流·极致',
  '纯插值放大(不用AI)'
] as const
export const RTX_PRECISIONS = ['8位', '10位(更精细)'] as const

export const UPSCALE_TIME_CHUNKS = ['自动（按显存）', '32', '24', '16', '12'] as const

/** 文案台 presets 出厂快捷短语（H3 文案台面板原配） */
export const DESK_PRESETS = [
  '镜头缓慢推进，主体保持在画面中央',
  '手持感轻微晃动，环境光偏冷',
  '固定机位，人物从左侧入画',
  '浅景深，背景柔和虚化',
  '环绕运镜，突出主角轮廓',
  '轻微推拉，节奏舒缓',
  '电影感宽银幕，暖色调',
  '自然光，写实风格'
] as const

// ---------- 默认参数（对齐模板作者原配）----------

export const defaultSla: SlaParams = {
  enabled: true,
  saveCompute: 95,
  skipFirstSteps: 0,
  refineLastSteps: 0,
  keepAudio: true,
  audioRefKeep: 0,
  blockSize: '64'
}

export const defaultMemOpt: MemOptimizerParams = {
  preset: MEM_PRESETS[0],
  feedforwardChunk: 1,
  chunkThreshold: 4096,
  headGroup: 1
}

export const defaultSelfLift: SelfLiftParams = {
  steps: '3,3',
  scale: '1.5',
  model: 'h3_upscaler_lms_v0.1.safetensors',
  tiling: '关（整幅收尾）',
  cleanup: 9,
  memMode: 'spatial',
  tokenChunk: 4096,
  weightCache: 4
}

export const defaultSigma: SigmaParams = { shiftVideo: 12, shiftAudio: 3 }

export const defaultPreview: PreviewParams = {
  maxResolution: 960,
  jpegQuality: 80,
  suppressDefault: true,
  previewFrames: 60,
  previewFps: 4,
  vaeName: 'MiniMax-H3-TAE.safetensors'
}

export const defaultVideoCombine: VideoCombineParams = {
  fps: 24,
  format: 'MP4 (H264/通用)',
  saveMetadata: true,
  notifyFile: 'notify.mp3',
  cleanAfter: true,
  customPath: ''
}

export const defaultRtx: RtxParams = {
  scaleMode: '按倍数放大',
  scale: 2,
  width: 1920,
  height: 1080,
  preset: '常规放大·极致',
  strength: 1,
  precision: '10位(更精细)',
  fps: 24,
  packVideo: true,
  keepAudio: true
}

export const defaultVram: VramParams = {
  guardGB: 0.2,
  cleanerUnload: true,
  cleanerCache: true
}

export const defaultNodeParams: NodeParams = {
  sla: { ...defaultSla },
  memOpt: { ...defaultMemOpt },
  selfLift: { ...defaultSelfLift },
  sigma: { ...defaultSigma },
  preview: { ...defaultPreview },
  videoCombine: { ...defaultVideoCombine },
  rtx: { ...defaultRtx },
  vram: { ...defaultVram },
  loraSlots: [],
  upscaleTimeChunk: '自动（按显存）',
  preDecodeSteps: 0,
  preDecodeStrength: 0.05
}

/** 克隆一份默认值（避免多处共享同一个可变对象） */
export function freshNodeParams(): NodeParams {
  return {
    sla: { ...defaultSla },
    memOpt: { ...defaultMemOpt },
    selfLift: { ...defaultSelfLift },
    sigma: { ...defaultSigma },
    preview: { ...defaultPreview },
    videoCombine: { ...defaultVideoCombine },
    rtx: { ...defaultRtx },
    vram: { ...defaultVram },
    loraSlots: [],
    upscaleTimeChunk: '自动（按显存）',
    preDecodeSteps: 0,
    preDecodeStrength: 0.05
  }
}

/**
 * 用默认值补全一份可能不完整的 nodeParams（老工程 / 用户只改了几项）。
 * 逐子对象 merge，保证注入层拿到的每个字段都有值。
 */
export function withNodeParamsDefaults(p: NodeParams | undefined): NodeParams {
  if (!p) return freshNodeParams()
  return {
    sla: { ...defaultSla, ...p.sla },
    memOpt: { ...defaultMemOpt, ...p.memOpt },
    selfLift: { ...defaultSelfLift, ...p.selfLift },
    sigma: { ...defaultSigma, ...p.sigma },
    preview: { ...defaultPreview, ...p.preview },
    videoCombine: { ...defaultVideoCombine, ...p.videoCombine },
    rtx: { ...defaultRtx, ...p.rtx },
    vram: { ...defaultVram, ...p.vram },
    loraSlots: Array.isArray(p.loraSlots) ? p.loraSlots : [],
    upscaleTimeChunk: p.upscaleTimeChunk ?? '自动（按显存）',
    preDecodeSteps: p.preDecodeSteps ?? 0,
    preDecodeStrength: p.preDecodeStrength ?? 0.05
  }
}
