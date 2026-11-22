/**
 * CSGlide 三大数据契约的权威 TS 定义与构造器。
 *
 * 对齐工作流节点包 工作流节点包 的前端面板 state：
 *   rack_data（媒体架）→ desk_data（文案台）→ h3_data（导演台）
 * 三者都是单行 STRING widget，后端做白名单解析。
 *
 * 本模块是「镜序工坊 → H3」的单一真相：任何要写进工作流 JSON 的三份契约，
 * 都从这里构造，避免各处手写 JSON 造成的字段名漂移、默认值陷阱与三态 alias 错误。
 *
 * 关键陷阱（来自 csglide_cast.py parse_h3_data 的实测默认值）：
 *   · 前端出厂 576×320 / length 243；后端默认 1344×768 / length 124。
 *     所以构造时必须**显式写全** width/height/length，不能依赖后端默认。
 *   · alias 是三态：缺失=开、显式 false=关。要关闭必须显式写 false。
 *   · 段身份统一 clip_XXXX，不用 uid/shot id。
 */

export const H3_MAX_IMAGES = 9
export const H3_MAX_VIDEOS = 3
export const H3_MAX_AUDIOS = 3

/** 参考素材槽（rack / h3 通用） */
export interface RefSlot {
  file?: string
  alias?: string[]
  start?: number
  end?: number
  audio?: boolean
  fps?: number
}

export interface MediaSlots {
  first?: RefSlot
  last?: RefSlot
  images: RefSlot[]
  videos: RefSlot[]
  audios: RefSlot[]
}

export function emptyMediaSlots(): MediaSlots {
  return {
    first: {},
    last: {},
    images: Array.from({ length: H3_MAX_IMAGES }, () => ({})),
    videos: Array.from({ length: H3_MAX_VIDEOS }, () => ({})),
    audios: Array.from({ length: H3_MAX_AUDIOS }, () => ({}))
  }
}

export interface ChainId {
  name: string
  clip: string
  shot?: string
}

/** 媒体架 rack_data —— 后端 emit() 只消费 slots / fps / audio_out */
export interface RackData {
  slots: {
    images: RefSlot[]
    videos: RefSlot[]
    audios: RefSlot[]
  }
  fps: number
  audio_out: number
  segs?: Record<string, { slots: RackData['slots']; fps: number; audio_out: number }>
  cur?: string
  shared?: boolean
  chain?: Partial<ChainId>
}

/** 文案台 desk_data —— 真正进提示词的是 global + segs[chain.clip] */
export interface DeskData {
  chain: ChainId
  global: string
  segs: Record<string, string>
  /** presets 只是面板快捷短语，不自动进提示词 */
  presets?: string[]
  alias?: boolean
  rewrite_system?: string
  rewrite_model?: string
}

/** 导演台 h3_data —— build() 产 8 输出 */
export interface H3Data {
  mode: 'ref2va' | 'fl2va' | 't2v'
  width: number
  height: number
  ratio: string
  length: number
  pin_head: number
  pin_tail: number
  ref_image_size: string
  ref_video_size: number
  ref_video_fps: number
  ref_scale_hd: number
  bridge_adapter: string
  bridge_alpha: number
  bridge_mode: string
  pace: number
  prompt: string
  slots: MediaSlots
  cont?: Record<string, unknown>
  push_whole: boolean
  push_film_latent?: boolean
  producer?: boolean
  /** 三态：缺失=开、显式 false=关 */
  alias?: boolean
  chain: ChainId
}

export interface SegmentBuildInput {
  chain: ChainId
  globalPrompt: string
  segmentPrompt: string
  width: number
  height: number
  ratio: string
  frames: number
  mode: H3Data['mode']
  /** 三态 alias：传 false 才关闭裸名展开；undefined=开 */
  alias?: boolean
  images?: RefSlot[]
  videos?: RefSlot[]
  audios?: RefSlot[]
  presets?: string[]
  pinHead?: number
  pinTail?: number
  refImageSize?: string
  refVideoSize?: number
  refVideoFps?: number
  refScaleHd?: number
  bridgeAdapter?: string
  bridgeAlpha?: number
  bridgeMode?: string
  pace?: number
  cont?: Record<string, unknown>
  pushWhole?: boolean
  fps?: number
  audioOut?: number
}

export interface SegmentContracts {
  rack: RackData
  desk: DeskData
  h3: H3Data
  rackJson: string
  deskJson: string
  h3Json: string
}

function fillSlots(src: RefSlot[] | undefined, cap: number): RefSlot[] {
  const out = Array.from({ length: cap }, () => ({}) as RefSlot)
  if (!Array.isArray(src)) return out
  src.slice(0, cap).forEach((s, i) => {
    if (s && typeof s === 'object' && s.file) out[i] = { ...s }
  })
  return out
}

/**
 * 从一段的语义参数构造三份契约（含序列化字符串）。
 * 所有字段显式写全，不依赖后端默认。
 */
export function buildSegmentContracts(input: SegmentBuildInput): SegmentContracts {
  const images = fillSlots(input.images, H3_MAX_IMAGES)
  const videos = fillSlots(input.videos, H3_MAX_VIDEOS)
  const audios = fillSlots(input.audios, H3_MAX_AUDIOS)
  const first = images[0]?.file ? { ...images[0] } : {}
  const last = images[images.length - 1]?.file ? { ...images[images.length - 1] } : {}

  const slots: MediaSlots = { first, last, images, videos, audios }

  const rack: RackData = {
    slots: { images, videos, audios },
    fps: input.fps ?? 24,
    audio_out: input.audioOut ?? 0,
    chain: { ...input.chain }
  }
  // H3 运行时按 segs[cur] 取素材：顶层写的同时也写当前段
  rack.segs = { [input.chain.clip]: { slots: { images, videos, audios }, fps: rack.fps, audio_out: rack.audio_out } }
  rack.cur = input.chain.clip

  const desk: DeskData = {
    chain: { ...input.chain },
    global: input.globalPrompt ?? '',
    segs: { [input.chain.clip]: input.segmentPrompt ?? '' },
    presets: input.presets ?? [],
    alias: input.alias === false ? false : true
  }

  const h3: H3Data = {
    mode: input.mode,
    width: input.width,
    height: input.height,
    ratio: input.ratio,
    length: input.frames,
    pin_head: input.pinHead ?? 0,
    pin_tail: input.pinTail ?? 0,
    ref_image_size: input.refImageSize ?? 'match',
    ref_video_size: input.refVideoSize ?? 768,
    ref_video_fps: input.refVideoFps ?? 24,
    ref_scale_hd: input.refScaleHd ?? 1,
    bridge_adapter: input.bridgeAdapter ?? '',
    bridge_alpha: input.bridgeAlpha ?? 0,
    bridge_mode: input.bridgeMode ?? 'full',
    pace: input.pace ?? 2.5,
    prompt: input.segmentPrompt ?? '',
    slots,
    push_whole: input.pushWhole ?? false,
    alias: input.alias === false ? false : true,
    chain: { ...input.chain }
  }
  if (input.cont) h3.cont = { ...input.cont }

  return {
    rack,
    desk,
    h3,
    rackJson: JSON.stringify(rack),
    deskJson: JSON.stringify(desk),
    h3Json: JSON.stringify(h3)
  }
}

/** 把参考图（文件名 + 称呼）变成带 alias 的槽位；称呼写进 alias 供提示词绑定 */
export function refSlotsFromFiles(files: string[], aliases?: string[]): RefSlot[] {
  return files.filter(Boolean).map((f, i) => {
    const a = aliases?.[i]?.trim()
    return { file: f, alias: a ? [a] : [f] }
  })
}

/** 判断三态 alias：显式 false 才关 */
export function aliasEnabled(v: boolean | undefined): boolean {
  return v !== false
}
