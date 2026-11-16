import type { ComfySettings } from '@shared/types'

/**
 * UI 工作流 → API 工作流转换。
 * 规则（已实测确认，见 scripts/convert-ui-to-api.mts 的演进史）：
 *   1. widgets_values 只含 widget 字段值，顺序 = object_info required+optional 里的 widget 字段顺序
 *   2. 「seed/随机种子」字段在 widgets_values 占 2 位（值 + mode 如 "fixed"），mode 丢弃
 *   3. link 字段从 UI links 六元组 [linkId, srcId, srcSlot, dstId, dstSlot, type] 填
 *   4. widget 判断：spec[0] 是字符串数组（传统 COMBO）、标量类型名（STRING/INT/FLOAT/BOOLEAN）、
 *      或 "COMBO"（新型 COMBO ["COMBO",{options}]）=> widget；否则 link
 */

const SCALAR_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'])

function isWidget(spec: unknown): boolean {
  const specArr = Array.isArray(spec) ? spec : [spec]
  const tv = specArr[0]
  if (Array.isArray(tv)) return true // 传统 COMBO：[["a","b"], {...}]
  return typeof tv === 'string' && SCALAR_TYPES.has(tv)
}

function isSeedField(name: string): boolean {
  return /seed|种子/i.test(name)
}

type UiWorkflow = {
  nodes: Array<{ id: string | number; type: string; inputs?: unknown[]; widgets_values?: unknown[] }>
  links: Array<[number, number | string, number, number | string, number, string?]>
}

export function isUiWorkflow(v: unknown): v is UiWorkflow {
  const o = v as UiWorkflow
  return Boolean(o && Array.isArray(o.nodes) && Array.isArray(o.links))
}

/**
 * 把 UI 格式工作流转成 API 格式（依赖 ComfyUI 在线，需 /object_info 判断字段类型）。
 * 转换时会：跳过 Note 便签、级联删除 RTX 超分节点及其依赖（本机未装 nvidia-vfx）。
 */
export async function convertUiToApi(
  ui: UiWorkflow,
  settings: ComfySettings
): Promise<Record<string, { class_type: string; inputs: Record<string, unknown> }>> {
  const base = `${settings.protocol}://${settings.host}:${settings.port}`
  const objInfo = (await (await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(15000) })).json()) as Record<
    string,
    { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
  >

  // links 六元组 → linkId -> 源信息
  const linkMap = new Map<number, { srcId: string; srcSlot: number }>()
  for (const l of ui.links) {
    const [linkId, srcId, srcSlot] = l
    linkMap.set(Number(linkId), { srcId: String(srcId), srcSlot: Number(srcSlot) })
  }

  const api: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}

  for (const n of ui.nodes) {
    const nodeId = String(n.id)
    if (n.type === 'Note') continue // 便签不参与生成
    const inputs: Record<string, unknown> = {}
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []

    const info = objInfo[n.type]
    const inputDef = info?.input || {}
    const required = inputDef.required || {}
    const optional = inputDef.optional || {}

    // widget 字段顺序
    const widgetFields: string[] = []
    for (const [name, spec] of [...Object.entries(required), ...Object.entries(optional)]) {
      if (isWidget(spec)) widgetFields.push(name)
    }

    // 消费 widgets_values（seed 字段占 2 位）
    let widx = 0
    for (const name of widgetFields) {
      if (widx >= wv.length) break
      if (isSeedField(name)) {
        inputs[name] = wv[widx]
        widx += 2
      } else {
        inputs[name] = wv[widx]
        widx += 1
      }
    }

    // link 字段
    const slotLinks = new Map<string, number>()
    if (Array.isArray(n.inputs)) {
      for (const slot of n.inputs as Array<{ name?: string; link?: number | null }>) {
        if (slot?.name && slot.link != null) slotLinks.set(slot.name, Number(slot.link))
      }
    }
    for (const [name, spec] of [...Object.entries(required), ...Object.entries(optional)]) {
      if (isWidget(spec)) continue
      const linkId = slotLinks.get(name)
      if (linkId != null) {
        const src = linkMap.get(linkId)
        if (src) inputs[name] = [src.srcId, src.srcSlot]
      }
    }

    api[nodeId] = { class_type: n.type, inputs }
  }

  // 级联删除 RTX 超分节点及其依赖
  const removeIds = new Set<string>()
  for (const [id, node] of Object.entries(api)) {
    if (node.class_type === 'BanZhang_RTX_SuperResolution' || node.class_type === 'H3_RTX_SuperResolution') {
      removeIds.add(id)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [id, node] of Object.entries(api)) {
      if (removeIds.has(id)) continue
      for (const v of Object.values(node.inputs)) {
        if (Array.isArray(v) && v.length >= 1 && removeIds.has(String(v[0]))) {
          removeIds.add(id)
          changed = true
          break
        }
      }
    }
  }
  for (const id of removeIds) delete api[id]

  return api
}

/** 判断工作流是视频还是图片类（用于模板 kind） */
export function detectWorkflowKind(api: Record<string, { class_type: string }>): 'image' | 'video' {
  const types = Object.values(api).map((n) => String(n.class_type))
  // 千问图片编辑/文生图以 CSGlideQwenCastCS 为核心 → 图片工作流。
  // 注意：该工作流末尾常带 h3VideoCombine 做输出封装，不能据此判成视频。
  const hasQwenImage = types.some((t) => /CSGlideQwenCastCS|CSGlideImageCastCS|QwenImage|TextEncodeQwenImage/i.test(t))
  const hasH3Video = types.some((t) => /CSGlideCastCS|CSGlideDeskCS/i.test(t))
  if (hasQwenImage && !hasH3Video) return 'image'
  // 明确的视频核心节点才算视频（h3VideoCombine 只是输出器，不算）
  for (const ct of types) {
    if (/CSGlideCastCS|CSGlideDeskCS|SaveVideo|VHS_VideoCombine|WanVideo|Mochi|LTXV|AnimateDiff/i.test(ct)) {
      return 'video'
    }
  }
  return 'image'
}
