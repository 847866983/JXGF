/**
 * 真实 H3 视频生成联调：用导演台模板 buildWorkflow 注入后提交 ComfyUI。
 * 6GB 显存 → 低分辨率短帧（512×288 @ 33 帧，t2v 模式）。
 * 运行：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/h3-e2e.mts
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { buildWorkflow } from '../src/main/core/workflow.ts'

const client = new ComfyClient('127.0.0.1', 8188)

// 读真实 H3 模板（api 格式）
const tplPath = 'D:/ManjuStudio/projects/哥们是女的/templates/tpl_e558c509b4c5.json'
const raw = JSON.parse(await fsp.readFile(tplPath, 'utf8'))
const template = {
  id: 'tpl_e558c509b4c5',
  name: 'H3 三采',
  kind: 'video' as const,
  description: '',
  apiJson: raw.api ?? raw,
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}

// 6GB 保守参数
const workflow = buildWorkflow(template, {
  positive: '一只发光的小白猫在雨夜古巷的石板路上缓缓走过，电影级灯光，3D 卡通渲染',
  width: 512,
  height: 288,
  frames: 33,
  seed: 12345,
  mode: 'ref2va'
}) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

// 删除模板里未安装的可选节点（RTX 超分依赖 nvidia-vfx，本机未装且不在主链）
const wfAny = workflow as unknown as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
const missingTypes = new Set(['H3_RTX_SuperResolution', 'H3_SuperResolution'])
const removeIds: string[] = []
for (const [id, node] of Object.entries(wfAny)) {
  if (node.class_type && missingTypes.has(node.class_type)) removeIds.push(id)
}
// 同时清除其他节点对已删节点的引用
for (const id of removeIds) delete wfAny[id]
for (const node of Object.values(wfAny)) {
  if (!node.inputs) continue
  for (const k of Object.keys(node.inputs)) {
    const v = node.inputs[k]
    if (Array.isArray(v) && v.length >= 1 && removeIds.includes(String(v[0]))) {
      delete node.inputs[k]
    }
  }
}
console.log('已删除未安装节点:', removeIds.join(', ') || '(无)')

// 验证注入结果
const deskNode = Object.values(workflow).find((n) => n.class_type === 'CSGlideDeskCS')
const castNode = Object.values(workflow).find((n) => n.class_type === 'CSGlideCastCS')
const desk = JSON.parse(String(deskNode?.inputs.desk_data)) as { chain?: { clip?: string }; segs?: Record<string, string> }
const h3 = JSON.parse(String(castNode?.inputs.h3_data)) as { width?: number; height?: number; length?: number; mode?: string }
console.log('注入检查:')
console.log('  desk.chain.clip =', desk.chain?.clip)
console.log('  desk.segs[clip] 前 40 字 =', desk.segs?.[desk.chain?.clip ?? '']?.slice(0, 40))
console.log('  h3 =', h3.width, 'x', h3.height, '@', h3.length, 'mode', h3.mode)

// 提交
await client.connect()
let promptId = ''
let lastPct = -1
client.on('progress', (p: { promptId?: string; percent: number }) => {
  if (p.promptId === promptId && p.percent !== lastPct) {
    lastPct = p.percent
    console.log('  进度', p.percent + '%')
  }
})

const outPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时（20 分钟）')), 20 * 60 * 1000)
  client.on('executed', (e: { promptId?: string; output?: Record<string, unknown> }) => {
    if (e.promptId === promptId) { clearTimeout(timer); resolve(e.output ?? {}) }
  })
  client.on('execution_error', (e: { promptId?: string; message?: string }) => {
    if (e.promptId === promptId) { clearTimeout(timer); reject(new Error(e.message ?? '执行失败')) }
  })
})

promptId = await client.submit(workflow)
console.log('prompt_id =', promptId)
const output = await outPromise
const videos = (output.videos ?? []) as { filename: string; subfolder: string; type: string }[]
console.log('输出视频:', videos.map((v) => v.filename).join(', ') || '(无视频)')

if (videos.length > 0) {
  const dest = path.join(os.tmpdir(), `ff_h3_${videos[0].filename}`)
  await client.download(videos[0].filename, videos[0].subfolder, videos[0].type, dest)
  const st = await fsp.stat(dest)
  console.log('下载到:', dest, '|', (st.size / 1024 / 1024).toFixed(1), 'MB')
}
client.close()
console.log('H3 E2E OK')
