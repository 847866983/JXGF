/**
 * 权威 UI→API 转换 v4（最终版）。
 * 关键规律（已实测确认）：
 *   - widgets_values 只包含 widget 字段的值，顺序 = object_info required+optional 里的 widget 字段顺序
 *   - 「seed/随机种子」字段在 widgets_values 里占 2 个位置（值 + mode 字符串如 "fixed"），mode 丢弃
 *   - link 字段单独从 UI 的 links 六元组填
 * 运行：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/convert-ui-to-api.mts <input.json> <output.json>
 */
import fsp from 'node:fs/promises'

const [inPath, outPath] = process.argv.slice(2)
if (!inPath || !outPath) {
  console.error('用法: node convert-ui-to-api.mts <input.json> <output.json>')
  process.exit(1)
}

const ui = JSON.parse(await fsp.readFile(inPath, 'utf8'))
const objInfo = await (await fetch('http://127.0.0.1:8188/object_info')).json()

const SCALAR_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'])

function isWidget(spec: unknown): boolean {
  const specArr = Array.isArray(spec) ? spec : [spec]
  const tv = specArr[0]
  if (Array.isArray(tv)) return true // 传统 COMBO：[["a","b"], {...}]
  return typeof tv === 'string' && SCALAR_TYPES.has(tv) // 标量 widget 或新型 COMBO ["COMBO",{options}]
}

function isSeedField(name: string): boolean {
  return /seed|种子/i.test(name)
}

// links 六元组: [linkId, srcId, srcSlotIndex, dstId, dstSlotIndex, type]
const linkMap = new Map<number, { srcId: string; srcSlot: number }>()
for (const l of ui.links) {
  const [linkId, srcId, srcSlot] = l
  linkMap.set(Number(linkId), { srcId: String(srcId), srcSlot: Number(srcSlot) })
}

const api: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}

for (const n of ui.nodes) {
  const nodeId = String(n.id)
  if (n.type === 'Note') continue // Note 便签不参与生成，跳过
  const inputs: Record<string, unknown> = {}
  const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []

  const info = objInfo[n.type]
  const inputDef = info?.input || {}
  const required = inputDef.required || {}
  const optional = inputDef.optional || {}

  // widget 字段顺序 = required 里的 widget + optional 里的 widget
  const widgetFields: string[] = []
  for (const [name, spec] of [...Object.entries(required), ...Object.entries(optional)]) {
    if (isWidget(spec)) widgetFields.push(name)
  }

  // 消费 widgets_values（seed 字段占 2 个位置）
  let widx = 0
  for (const name of widgetFields) {
    if (widx >= wv.length) break
    if (isSeedField(name)) {
      inputs[name] = wv[widx] // 种子值
      widx += 2 // 跳过 mode 字符串
    } else {
      inputs[name] = wv[widx]
      widx += 1
    }
  }

  // link 字段从 UI inputs 数组的 slot.link + linkMap 填
  const slotLinks = new Map<string, number>()
  if (Array.isArray(n.inputs)) {
    for (const slot of n.inputs) {
      if (slot?.name && slot.link != null) slotLinks.set(slot.name, Number(slot.link))
    }
  }
  for (const [name, spec] of [...Object.entries(required), ...Object.entries(optional)]) {
    if (isWidget(spec)) continue // 已经是 widget
    const linkId = slotLinks.get(name)
    if (linkId != null) {
      const src = linkMap.get(linkId)
      if (src) inputs[name] = [src.srcId, src.srcSlot]
    }
  }

  api[nodeId] = { class_type: n.type, inputs }
}

// 级联删除：RTX 超分节点 + 依赖它的节点（如超分收尾 VideoCombine）
const REMOVED = new Set(['BanZhang_RTX_SuperResolution'])
const removeIds = new Set<string>()
for (const [id, node] of Object.entries(api)) {
  if (REMOVED.has(node.class_type)) removeIds.add(id)
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

await fsp.writeFile(outPath, JSON.stringify(api, null, 2), 'utf8')
console.log(`转换完成: 节点数 ${Object.keys(api).length}（已级联删除 ${removeIds.size} 个依赖 RTX 的节点）`)

// 验证：打印含种子字段的节点
for (const [id, node] of Object.entries(api)) {
  for (const [k, v] of Object.entries(node.inputs)) {
    if (/seed|种子/i.test(k) && !Array.isArray(v)) {
      console.log(`  ${node.class_type}(${id}).${k} = ${v}`)
    }
  }
}
