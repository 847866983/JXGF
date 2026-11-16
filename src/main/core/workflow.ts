import type { Template, UpscaleSettings, RifeSettings } from '@shared/types'

export interface WorkflowParams {
  positive?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
  /** 每批生成张数（图片批量出图用） */
  batch?: number
  /** 采样器细参（视频/图片生成共用） */
  steps?: number
  cfg?: number
  samplerName?: string
  scheduler?: string
  /** 生成模式：t2v（文生视频）/ fl2va（首尾帧）/ ref2va（参考图生视频） */
  mode?: 't2v' | 'fl2va' | 'ref2va'
  /** 分段导演台：覆盖 h3_data 的字段（ratio、pin_head、ref_* 、bridge_* 、cont、push_whole、chain） */
  h3?: Record<string, unknown>
  /** 放大重绘参数 */
  upscale?: UpscaleSettings
  /** 抽帧 / 插帧参数 */
  rife?: RifeSettings
}

type WorkflowNode = { id: string; class_type: string; inputs: Record<string, unknown> }
type Workflow = Record<string, WorkflowNode>

function isWorkflowObject(v: unknown): v is Record<string, WorkflowNode> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function textNodeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputs)) {
    if (k === 'text' || /prompt|text/i.test(k)) out[k] = v
  }
  return out
}

interface DeskData {
  chain?: { name?: string; clip?: string; shot?: string }
  global?: string
  segs?: Record<string, string>
}

interface H3Data {
  mode?: string
  width?: number
  height?: number
  length?: number
  prompt?: string
  [k: string]: unknown
}

function tryParse<T>(v: unknown): T | null {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/**
 * 找到节点里存放 h3_data 的字段名（不同版本叫法不同：h3_data 或 first_frame）。
 */
function h3DataField(node: WorkflowNode): string | null {
  for (const key of ['h3_data', 'first_frame']) {
    if (typeof node.inputs[key] === 'string') return key
  }
  return null
}

/**
 * 找到节点里存放 desk_data 的字段名（desk_data 或「外接提示词」）。
 */
function deskDataField(node: WorkflowNode): string | null {
  for (const key of ['desk_data', '外接提示词', '外接提示词 ']) {
    if (typeof node.inputs[key] === 'string') return key
  }
  return null
}

/**
 * 把 MiniMax-H3 工作流的提示词写进 CSGlideDeskCS 的 desk_data.segs。
 */
function injectH3Prompt(clone: Workflow, positive: string): boolean {
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideDeskCS') continue
    const field = deskDataField(node)
    if (!field) continue
    const desk = tryParse<DeskData>(node.inputs[field])
    if (!desk) continue

    const clip = desk.chain?.clip ?? 'clip_0001'
    desk.segs = desk.segs ?? {}
    desk.segs[clip] = positive
    if (desk.chain) desk.chain.shot = clip
    node.inputs[field] = JSON.stringify(desk)
    return true
  }
  return false
}

/**
 * 注入 H3 的尺寸 / 帧数 / 模式到 CSGlideCastCS 的 h3_data（或 first_frame）。
 */
function injectH3Data(clone: Workflow, params: WorkflowParams): void {
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<H3Data>(node.inputs[field])
    if (!h3) continue
    if (params.width) h3.width = params.width
    if (params.height) h3.height = params.height
    if (params.frames) h3.length = params.frames
    if (params.mode) h3.mode = params.mode
    // 分段导演台覆盖字段（画布比例/保留头尾/参考/语义桥/续接/整片潜空间/链身份）
    if (params.h3) {
      for (const [k, v] of Object.entries(params.h3)) {
        if (v !== undefined) h3[k] = v
      }
    }
    // 只清 cont（续拍存档路径残留，避免续到错误的上次 latent）。
    // 但分段导演台显式传入 cont（续接）时必须保留。
    const contExplicit = params.h3 ? Object.prototype.hasOwnProperty.call(params.h3, 'cont') : false
    if (h3.cont && !contExplicit) delete h3.cont
    node.inputs[field] = JSON.stringify(h3)
  }
}

/**
 * t2v 模式下清空参考图残留：媒体架 rack_data、VisualLoader 指定文件。
 * ref2va / fl2va 模式才需要参考图，t2v 需要干净输入，否则主链路会短路。
 */
function clearH3Refs(clone: Workflow, mode?: string): void {
  if (mode !== 't2v') return
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (ct === 'CSGlideH3MediaRackCS' && typeof node.inputs.rack_data === 'string') {
      const rack = tryParse<Record<string, unknown>>(node.inputs.rack_data)
      if (rack) {
        rack.slots = { images: [], videos: [], audios: [] }
        if (rack.segs && typeof rack.segs === 'object') {
          const segs = rack.segs as Record<string, unknown>
          for (const key of Object.keys(segs)) {
            const s = segs[key] as Record<string, unknown>
            if (s && typeof s === 'object') s.slots = { images: [], videos: [], audios: [] }
          }
        }
        node.inputs.rack_data = JSON.stringify(rack)
      }
    }
    if (ct === 'H3VisualLoader' && '📄 指定文件' in node.inputs) {
      node.inputs['📄 指定文件'] = ''
    }
  }
}

/**
 * 把参考图文件名注入 H3 媒体架（CSGlideH3MediaRackCS 的 rack_data.slots.images）。
 * refImages 是已上传到 ComfyUI input 的文件名（如 cglide/xxx.png）。
 * 参考图会作为 ref2va 的素材，首张同时作为首帧。
 */
export function injectH3RefImages(clone: unknown, refImages: string[]): void {
  if (refImages.length === 0) return
  if (!isWorkflowObject(clone)) return
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (ct !== 'CSGlideH3MediaRackCS') continue
    const raw = node.inputs.rack_data
    if (typeof raw !== 'string') continue
    const rack = tryParse<Record<string, unknown>>(raw)
    if (!rack) continue
    const slots = (rack.slots as { images?: { file?: string; alias?: string[] }[] } | undefined) ?? {}
    const images = Array.isArray(slots.images) ? slots.images : []
    // 清掉旧参考，填入新参考
    slots.images = refImages.map((f) => ({ file: f, alias: [f] }))
    rack.slots = slots
    node.inputs.rack_data = JSON.stringify(rack)
  }
}

/**
 * H3 参数一致性修正（实测必需，否则 SelfLift 报错）：
 * 1. SelfLift「分段步数」合计必须等于 KSampler 的 steps，否则 ValueError。
 * 2. 无效调度器名（如 bong_tangent）会导致 calculate_sigmas 报错，改成 simple。
 */
function fixH3Params(clone: Workflow): void {
  let ksamplerSteps: number | null = null
  for (const node of Object.values(clone)) {
    if (String(node.class_type) === 'KSampler' && typeof node.inputs.steps === 'number') {
      ksamplerSteps = node.inputs.steps
      break
    }
  }
  for (const node of Object.values(clone)) {
    const inputs = node.inputs
    // SelfLift 分段步数对齐 KSampler steps
    if (typeof inputs['分段步数'] === 'string' && ksamplerSteps !== null) {
      const total = ksamplerSteps
      const half = Math.floor(total / 2)
      inputs['分段步数'] = `${half},${total - half}`
    }
    // 无效调度器 -> simple
    if (inputs['调度器'] === 'bong_tangent') {
      inputs['调度器'] = 'simple'
    }
  }
}

/**
 * 通用采样器细参注入：对 KSampler / KSamplerAdvanced 设置 steps/cfg/sampler_name/scheduler。
 * 放在 H3 参数修正之前，这样 SelfLift 分段步数能按新 steps 对齐。
 */
function applySamplerParams(clone: Workflow, params: WorkflowParams): void {
  for (const node of Object.values(clone)) {
    if (!/^KSampler(Advanced)?$/.test(String(node.class_type))) continue
    const inp = node.inputs
    if (params.steps !== undefined && 'steps' in inp) inp.steps = params.steps
    if (params.cfg !== undefined && 'cfg' in inp) inp.cfg = params.cfg
    if (params.samplerName && 'sampler_name' in inp) inp.sampler_name = params.samplerName
    if (params.scheduler && 'scheduler' in inp) inp.scheduler = params.scheduler
  }
}

/**
 * 视频参考：把上传后的参考视频写入 H3 媒体架（slots.videos）。
 */
export function injectH3RefVideos(clone: unknown, refVideos: string[]): void {
  if (refVideos.length === 0) return
  if (!isWorkflowObject(clone)) return
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (ct !== 'CSGlideH3MediaRackCS') continue
    const raw = node.inputs.rack_data
    if (typeof raw !== 'string') continue
    const rack = tryParse<Record<string, unknown>>(raw)
    if (!rack) continue
    const slots = (rack.slots as { videos?: { file?: string; alias?: string[] }[] } | undefined) ?? {}
    slots.videos = refVideos.map((f) => ({ file: f, alias: [f] }))
    rack.slots = slots
    node.inputs.rack_data = JSON.stringify(rack)
  }
}

/**
 * 同步 CSGlideDeskCS 的 chain/clip 与 CSGlideCastCS.h3_data.chain 一致，
 * 并把 desk_data.segs 里旧 clip 的提示词迁到新 clip，保证提示词挂到正确的段。
 */
function syncH3DeskChain(clone: Workflow): void {
  let h3chain: { name?: string; clip?: string; shot?: string } | null = null
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<{ chain?: { name?: string; clip?: string; shot?: string } }>(node.inputs[field])
    if (h3?.chain?.name) h3chain = h3.chain
  }
  if (!h3chain?.name) return

  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideDeskCS') continue
    const field = deskDataField(node)
    if (!field) continue
    const desk = tryParse<DeskData>(node.inputs[field])
    if (!desk) continue
    const oldClip = desk.chain?.clip
    const newClip = h3chain.clip || oldClip
    desk.segs = desk.segs ?? {}
    if (oldClip && newClip && oldClip !== newClip && desk.segs[oldClip] !== undefined) {
      desk.segs[newClip] = desk.segs[oldClip]
      delete desk.segs[oldClip]
    }
    desk.chain = { name: h3chain.name, clip: newClip, shot: h3chain.shot }
    node.inputs[field] = JSON.stringify(desk)
  }
}

/**
 * 放大重绘参数注入（BanZhang_MMH3_Upscale / UpscaleParams）。
 */
function applyUpscaleParams(clone: Workflow, up: UpscaleSettings): void {
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    const i = node.inputs
    if (ct === 'BanZhang_MMH3_Upscale') {
      // 关键：这些节点即使"关闭放大"仍在链路中执行，去噪强度=0 会导致 steps/denoise 除零。
      // 关闭时保留安全默认值，绝不写 0。
      const steps = Math.max(1, Number(up.steps) || 2)
      const denoise = Math.max(0.05, Number(up.denoise) || 0.45)
      const audioDenoise = Math.max(0.05, Number(up.audioDenoise) || 0.3)
      if ('步数' in i) i['步数'] = steps
      if ('去噪强度' in i) i['去噪强度'] = denoise
      if ('音频重绘强度' in i) i['音频重绘强度'] = audioDenoise
      if ('采样器' in i && up.sampler) i['采样器'] = up.sampler
      if ('调度器' in i && up.scheduler) i['调度器'] = up.scheduler
    } else if (ct === 'BanZhang_MMH3_UpscaleParams') {
      if ('放大模式' in i) i['放大模式'] = up.enabled ? up.mode : '按倍数'
      if ('放大倍数' in i) i['放大倍数'] = up.enabled ? Math.max(1, up.scale) : 1
      if ('目标宽度' in i) i['目标宽度'] = up.targetWidth
      if ('目标高度' in i) i['目标高度'] = up.targetHeight
      if ('每块帧数' in i) i['每块帧数'] = up.tileFrames
      if ('重叠帧数' in i) i['重叠帧数'] = up.overlapFrames
    }
  }
}

/**
 * 抽帧 / 插帧参数注入（BanZhang_RIFE_Interpolation）。
 */
function applyRifeParams(clone: Workflow, rife: RifeSettings): void {
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'BanZhang_RIFE_Interpolation') continue
    const i = node.inputs
    if ('插帧倍数' in i) i['插帧倍数'] = rife.enabled ? rife.multiplier : 1
    if ('序列源帧率' in i) i['序列源帧率'] = rife.fps
    if ('保留原音' in i) i['保留原音'] = rife.keepAudio ? '开' : '关'
  }
}

/**
 * 把模板（API 格式）与镜头参数合成最终提交给 ComfyUI 的工作流。
 *
 * 采用「探测式注入」，节点 ID 永不写死：
 * - 若模板含 CSGlideDeskCS / CSGlideCastCS（MiniMax-H3），走 H3 专用注入；
 * - 否则回退到通用 CLIPTextEncode / EmptyLatentImage 注入。
 */
export function buildWorkflow(template: Template, params: WorkflowParams): unknown {
  if (!isWorkflowObject(template.apiJson)) {
    throw new Error('模板不是有效的 API 工作流（缺少 nodes 结构）')
  }
  const clone: Workflow = JSON.parse(JSON.stringify(template.apiJson)) as Workflow

  // 先注入采样器细参（steps/cfg/sampler/scheduler），H3 的 SelfLift 会据此对齐
  applySamplerParams(clone, params)

  const isH3 = Object.values(clone).some((n) => String(n.class_type).includes('CSGlide'))

  if (isH3) {
    if (params.positive !== undefined) {
      injectH3Prompt(clone, params.positive)
    }
    injectH3Data(clone, params)
    syncH3DeskChain(clone)
    if (params.upscale) applyUpscaleParams(clone, params.upscale)
    if (params.rife) applyRifeParams(clone, params.rife)
    clearH3Refs(clone, params.mode)
    fixH3Params(clone)
    // H3 的种子在 KSampler 节点
    if (params.seed !== undefined) {
      for (const node of Object.values(clone)) {
        if (String(node.class_type) === 'KSampler' && 'seed' in node.inputs) {
          node.inputs.seed = params.seed
        }
      }
    }
    return clone
  }

  // ---- 通用（非 H3）路径 ----
  const textNodes = Object.values(clone).filter((n) => String(n.class_type).includes('CLIPTextEncode'))

  if (params.positive !== undefined && textNodes[0]) {
    const t = textNodes[0].inputs
    const key = Object.keys(t).find((k) => /text|prompt/i.test(k)) ?? 'text'
    t[key] = params.positive
  }
  if (params.negative !== undefined && textNodes[1]) {
    const t = textNodes[1].inputs
    const key = Object.keys(t).find((k) => /text|prompt/i.test(k)) ?? 'text'
    t[key] = params.negative
  }

  for (const node of Object.values(clone)) {
    const ct = String(node.class_type).toLowerCase()
    if (ct.includes('emptylatentimage') || ct.includes('latent')) {
      if (params.width && 'width' in node.inputs) node.inputs.width = params.width
      if (params.height && 'height' in node.inputs) node.inputs.height = params.height
      if (params.batch && 'batch_size' in node.inputs) node.inputs.batch_size = params.batch
    }
    if (params.seed !== undefined && 'seed' in node.inputs) {
      node.inputs.seed = params.seed
    }
    if (params.frames && ('frames' in node.inputs || 'length' in node.inputs)) {
      const key = 'frames' in node.inputs ? 'frames' : 'length'
      node.inputs[key] = params.frames
    }
  }
  return clone
}

export function collectTextDefaults(workflow: unknown): { positive: string; negative: string } {
  if (!isWorkflowObject(workflow)) return { positive: '', negative: '' }
  const textNodes = Object.values(workflow)
    .filter((n) => String(n.class_type).includes('CLIPTextEncode'))
    .map((n) => textNodeInputs(n.inputs))
  const positive = textNodes[0] ? String(Object.values(textNodes[0])[0] ?? '') : ''
  const negative = textNodes[1] ? String(Object.values(textNodes[1])[0] ?? '') : ''
  return { positive, negative }
}

/**
 * 从 H3 工作流（API 格式）提取链式续接的工程名和分段 id。
 * 供提交前登记（registerClip）用。非 H3 模板返回 null。
 */
export function extractH3Chain(workflow: unknown): { name: string; shot: string } | null {
  if (!isWorkflowObject(workflow)) return null
  for (const node of Object.values(workflow)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<{ chain?: { name?: string; shot?: string } }>(node.inputs[field])
    const name = h3?.chain?.name?.trim()
    if (!name) continue
    return { name, shot: h3?.chain?.shot?.trim() ?? '' }
  }
  return null
}
