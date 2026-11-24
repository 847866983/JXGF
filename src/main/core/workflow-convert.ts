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

/** 分组标题 → 阶段 key */
function stageOfTitle(title: string): StageKey | null {
  if (/超分/.test(title)) return 'superRes'
  if (/三采/.test(title)) return 'third'
  if (/二采/.test(title)) return 'second'
  if (/一采/.test(title)) return 'first'
  return null
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
export type StageKey = 'first' | 'second' | 'third' | 'superRes'
export type StageFlags = Record<StageKey, boolean>

export async function convertUiToApi(
  ui: UiWorkflow,
  settings: ComfySettings,
  opts: {
    keepSuperRes?: boolean
    /** 各阶段开关：关闭的阶段节点会被真正删除（含其下游），不再执行、不再播报提示音 */
    stages?: StageFlags
    stageParams?: Partial<Record<StageKey, { steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number }>>
  } = {}
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

  /**
   * 纯前端节点（只有界面意义，后端不注册）。
   * 导出成 API 时如果把它们提交上去，ComfyUI 会报
   * `missing_node_type: Node 'Label (rgthree)' not found`。
   * 它们没有输出、或输出只用于界面，直接丢掉不影响生成。
   */
  const UI_ONLY_NODES = new Set([
    'Note',
    'Label (rgthree)',
    'Bookmark (rgthree)',
    'Fast Groups Bypasser (rgthree)',
    'Fast Groups Muter (rgthree)',
    'Reroute',
    'PrimitiveNode',
    'GetNode',
    'SetNode'
  ])

  // —— Bypass 透传：被 Bypass(4) 的节点不会进 API，但它的下游还连着它。
  //    必须顺着它「同类型的第一个输入」往上找真正的源头，否则下游会指向一个
  //    不存在的节点 id，ComfyUI 校验时报 "Exception when validating inner node: '431'"，
  //    然后整条输出被丢弃 —— 表现就是"执行成功但零产物"。
  const nodesById = new Map(ui.nodes.map((x) => [String(x.id), x as unknown as {
    id: number | string; inputs?: { type?: string; link?: number | null }[]; outputs?: { type?: string }[]
  }]))
  const bypassedIds = new Set(
    ui.nodes
      .filter((x) => Number((x as unknown as { mode?: number }).mode) === 4)
      .map((x) => String(x.id))
  )
  const resolveBypassedLink = (linkId: number): [string, number] | null => {
    let cur = linkMap.get(linkId)
    const seen = new Set<number>()
    while (cur) {
      const srcNode = nodesById.get(cur.srcId)
      if (!srcNode || !bypassedIds.has(cur.srcId)) return [cur.srcId, cur.srcSlot]
      const outType = String(srcNode.outputs?.[cur.srcSlot]?.type ?? '*')
      const match = (srcNode.inputs ?? []).find(
        (i) => i?.link != null && (String(i.type) === outType || outType === '*' || i.type === '*')
      )
      if (!match || match.link == null || seen.has(Number(match.link))) return null
      seen.add(Number(match.link))
      cur = linkMap.get(Number(match.link))
    }
    return null
  }

  for (const n of ui.nodes) {
    const nodeId = String(n.id)
    // 便签/标注等纯界面节点不参与生成
    if (UI_ONLY_NODES.has(n.type)) continue
    // 跳过被 Bypass（4）/ Mute（2）的节点。
    // 不跳过的后果：工作流里留着整条废弃分支（例如 Krea2 的 MuseByStable 旧方案），
    // 它引用的模型/节点可能根本没装，ComfyUI 校验时直接报
    // 「value_not_in_list / missing_node_type」——看起来像"模型不在目录里"，
    // 其实那条分支压根不该执行。
    const nodeMode = Number((n as { mode?: number }).mode ?? 0)
    if (nodeMode === 4 || nodeMode === 2) continue
    const inputs: Record<string, unknown> = {}
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []

    const info = objInfo[n.type]
    // 后端不认识、且这个节点没有任何输出连线 → 一定是装饰性节点，丢掉
    if (!info) {
      const outputs = (n as { outputs?: { links?: number[] | null }[] }).outputs
      const hasOutgoing = Array.isArray(outputs) && outputs.some((o) => (o?.links?.length ?? 0) > 0)
      if (!hasOutgoing) continue
    }
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
        const src = resolveBypassedLink(linkId)
        if (src) inputs[name] = [src[0], src[1]]
      }
    }

    api[nodeId] = { class_type: n.type, inputs }
  }

  // 按阶段开关级联删除节点：关闭的阶段 = 整组节点（含采样/解码/输出 Combine 与提示音）都不执行。
  // 阶段按 一采→二采→三采→超分 串联，删上游会级联删掉依赖它的下游（例如关一采则二采三采也失效）。
  const removeIds = new Set<string>()
  const stages: StageFlags = opts.stages ?? {
    first: true,
    second: true,
    third: true,
    superRes: opts.keepSuperRes === true
  }
  const hasStageFlags = Boolean(opts.stages)
  if (hasStageFlags) {
    const groups = ((ui as unknown as { groups?: { title?: string; bounding?: number[] }[] }).groups ?? [])
    for (const g of groups) {
      const st = stageOfTitle(String(g.title ?? ''))
      if (!st || stages[st]) continue // 开启的阶段保留
      const b = g.bounding
      if (!Array.isArray(b)) continue
      for (const n of ui.nodes) {
        const pos = (n as unknown as { pos?: number[] }).pos
        if (Array.isArray(pos) && pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3]) {
          removeIds.add(String(n.id))
        }
      }
    }
  } else if (!opts.keepSuperRes) {
    // 兼容旧调用：只删超分节点
    for (const [id, node] of Object.entries(api)) {
      if (node.class_type === 'BanZhang_RTX_SuperResolution' || node.class_type === 'H3_RTX_SuperResolution') {
        removeIds.add(id)
      }
    }
  }
  // 级联：任何节点的输入若引用了被删节点（串联下游），一并删除
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

  // 按分组套用各阶段采样参数（一采/二采/三采/超分 各自一套）
  if (opts.stageParams) {
    const groups = ((ui as unknown as { groups?: { title?: string; bounding?: number[] }[] }).groups ?? [])
    for (const n of ui.nodes) {
      const pos = (n as unknown as { pos?: number[] }).pos
      if (!Array.isArray(pos)) continue
      const g = groups.find((x) => {
        const b = x.bounding
        return Array.isArray(b) && pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3]
      })
      if (!g) continue
      const st = stageOfTitle(String(g.title ?? ''))
      if (!st) continue
      const cfg = opts.stageParams[st]
      if (!cfg) continue
      const node = api[String(n.id)]
      if (!node) continue
      // 一采用标准 KSampler；二采/三采用 BanZhang_MMH3_Upscale（字段名不同）
      const isKSampler = /KSampler/.test(node.class_type)
      const isUpscale = /MMH3_Upscale/.test(node.class_type)
      if (!isKSampler && !isUpscale) continue
      /** 该节点某字段在 object_info 里的 COMBO 选项（用于白名单校验；非 COMBO 返回 null） */
      const comboOptions = (field: string): string[] | null => {
        const info = objInfo[node.class_type]
        const spec = { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) }[field]
        const t = Array.isArray(spec) ? spec[0] : spec
        return Array.isArray(t) ? t.map(String) : null
      }
      /** 只在选项白名单内才覆盖：用户填了本机 ComfyUI 不认识的调度器/采样器时，
          保留模板原值（第三方调度器仍会被 adaptTemplateForGpu 兜底映射），避免 value_not_in_list 直接失败 */
      const setIfValid = (field: string, value: unknown): boolean => {
        if (!(field in node.inputs)) return false
        const options = comboOptions(field)
        if (options && !options.includes(String(value))) return false
        node.inputs[field] = value
        return true
      }
      if (cfg.steps !== undefined) {
        for (const k of isUpscale ? ['步数', 'steps'] : ['steps']) if (k in node.inputs) node.inputs[k] = cfg.steps
      }
      // MMH3_Upscale 没有 cfg 字段：这里天然跳过（UI 已对不支持 CFG 的阶段禁用该输入）
      if (cfg.cfg !== undefined && 'cfg' in node.inputs) node.inputs.cfg = cfg.cfg
      if (cfg.sampler) {
        for (const k of isUpscale ? ['采样器', 'sampler', 'sampler_name'] : ['sampler_name']) {
          if (setIfValid(k, cfg.sampler)) break
        }
      }
      if (cfg.scheduler) {
        for (const k of isUpscale ? ['调度器', 'scheduler'] : ['scheduler']) {
          if (setIfValid(k, cfg.scheduler)) break
        }
      }
      if (cfg.denoise !== undefined) {
        for (const k of isUpscale ? ['去噪强度', 'denoise'] : ['denoise']) if (k in node.inputs) node.inputs[k] = cfg.denoise
      }
    }
  }

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
