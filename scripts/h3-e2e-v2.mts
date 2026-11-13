/**
 * 真实 H3 生成联调 v2：用新工作流 minimax h3-三采-1031.json（UI 格式 → API 格式）。
 * ref2va 模式（模型是 fl2va+ref2va 混合权重，无 t2v）。
 * 运行：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/h3-e2e-v2.mts
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { buildWorkflow } from '../src/main/core/workflow.ts'

const client = new ComfyClient('127.0.0.1', 8188)

// 用正确转换好的 API 格式（由 convert-ui-to-api.mts 生成）
const api = JSON.parse(await fsp.readFile('E:/剧本/h3-1031-api.json', 'utf8'))

console.log('API 节点数:', Object.keys(api).length)

const template = {
  id: 'tpl_h3_1031',
  name: 'H3 三采 1031',
  kind: 'video' as const,
  description: '',
  apiJson: api,
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}

const workflow = buildWorkflow(template, {
  positive: '一只发光的小白猫在雨夜古巷石板路上缓缓走过，电影级灯光，3D 卡通渲染，雨滴反射',
  width: 512,
  height: 288,
  frames: 33,
  seed: 777,
  mode: 'ref2va'
}) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

// 修正 SelfLift 分段步数与 KSampler 步数对齐
const ksamplerSteps = (workflow['277']?.inputs as Record<string, unknown>)?.steps
for (const node of Object.values(workflow)) {
  const inputs = node.inputs as Record<string, unknown>
  if (typeof inputs['分段步数'] === 'string' && ksamplerSteps !== undefined) {
    const total = Number(ksamplerSteps)
    const half = Math.floor(total / 2)
    inputs['分段步数'] = `${half},${total - half}`
    console.log('修正 SelfLift 分段步数 ->', inputs['分段步数'])
  }
  // 修正无效调度器名 bong_tangent -> simple
  if (inputs['调度器'] === 'bong_tangent') {
    inputs['调度器'] = 'simple'
    console.log('修正调度器 bong_tangent -> simple')
  }
}

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
console.log('H3 v2 E2E 完成')
