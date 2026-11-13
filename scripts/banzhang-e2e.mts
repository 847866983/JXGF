// 端到端验证：用项目里的 BanZhang 模板 + buildWorkflow 跑真实 H3 出片
import fsp from 'node:fs/promises'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { buildWorkflow, extractH3Chain } from '../src/main/core/workflow.ts'

const client = new ComfyClient('127.0.0.1', 8188)

let raw = await fsp.readFile('C:/Users/84786/AppData/Roaming/frameforge/projects/prj_ac2719032d9b/project.json', 'utf8')
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
const project = JSON.parse(raw)
const template = project.templates.find((t) => t.name.includes('BanZhang'))
console.log('使用模板:', template.name)

const workflow = buildWorkflow(template, {
  positive: '一只发光的小白猫在雨夜古巷石板路上缓缓走过，电影级灯光，3D 卡通渲染，雨滴反射',
  width: 512,
  height: 288,
  frames: 33,
  seed: 888,
  mode: 'ref2va'
}) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

console.log('工作流节点数:', Object.keys(workflow).length)

await client.connect()

// 登记链式续接
const chain = extractH3Chain(workflow)
if (chain) {
  const cid = await client.registerClip(chain.name, { shot: chain.shot, frames: 33 })
  console.log('登记段落:', chain.name, '->', cid)
}

let promptId = ''
let lastPct = -1
client.on('progress', (p) => { if (p.promptId === promptId && p.percent !== lastPct) { lastPct = p.percent; console.log('  进度', p.percent + '%') } })

const outPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时（20分钟）')), 20 * 60 * 1000)
  client.on('executed', (e) => { if (e.promptId === promptId) { clearTimeout(timer); resolve(e.output ?? {}) } })
  client.on('execution_error', (e) => { if (e.promptId === promptId) { clearTimeout(timer); reject(new Error(e.message ?? '执行失败')) } })
})

promptId = await client.submit(workflow)
console.log('prompt_id =', promptId)
const output = await outPromise
const videos = (output.videos ?? [])
console.log('输出视频:', videos.map((v) => v.filename).join(', ') || '(无视频)')
client.close()
console.log('BanZhang E2E 完成')
