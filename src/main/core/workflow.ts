import type { Template } from '@shared/types'

export interface WorkflowParams {
  positive?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
  /** 生成模式：t2v（文生视频）/ fl2va（首尾帧）/ ref2va（参考图生视频） */
  mode?: 't2v' | 'fl2va' | 'ref2va'
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
    if (h3.cont) delete h3.cont
    if (h3.chain) delete h3.chain
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

  const isH3 = Object.values(clone).some((n) => String(n.class_type).includes('CSGlide'))

  if (isH3) {
    if (params.positive !== undefined) {
      injectH3Prompt(clone, params.positive)
    }
    injectH3Data(clone, params)
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
