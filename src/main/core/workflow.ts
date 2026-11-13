import type { Template } from '@shared/types'

export interface WorkflowParams {
  positive?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
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

/**
 * 把模板（API 格式）与镜头参数合成最终提交给 ComfyUI 的工作流。
 *
 * v1 采用「探测式注入」：遍历所有节点，凡是 CLIPTextEncode 类文本节点，
 * 按约定顺序把 positive 写进第一个、negative 写进第二个；
 * 尺寸 / 帧数写入 EmptyLatentImage 或常见视频节点。
 * 后续引入「参数映射」后，这里会改成按 mapping 精确绑定，节点 ID 永不写死。
 */
export function buildWorkflow(template: Template, params: WorkflowParams): unknown {
  if (!isWorkflowObject(template.apiJson)) {
    throw new Error('模板不是有效的 API 工作流（缺少 nodes 结构）')
  }
  const clone: Workflow = JSON.parse(JSON.stringify(template.apiJson)) as Workflow
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
