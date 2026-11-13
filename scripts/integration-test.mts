/**
 * 真实 ComfyUI 端到端联调：不依赖任何模型。
 * 链路：system_stats → upload → submit → WS executed → /view 下载落盘。
 * 运行：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/integration-test.mts
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ComfyClient } from '../src/main/core/comfy.ts'

const client = new ComfyClient('127.0.0.1', 8188)

const stats = await client.systemStats()
console.log('1. system_stats:', stats.online ? `online v${stats.version}` : 'OFFLINE', '| gpu:', stats.gpu?.name ?? '-')
if (!stats.online) {
  console.error('ComfyUI 未连接，请确认已启动（127.0.0.1:8188）')
  process.exit(1)
}

const up = await client.uploadImage(path.resolve('build/icon.png'))
console.log('2. upload ->', JSON.stringify(up))

const workflow = {
  '1': { class_type: 'LoadImage', inputs: { image: up.name } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ff_e2e' } }
}

await client.connect()
let promptId = ''
let lastPercent = -1
client.on('progress', (p: { promptId?: string; percent: number }) => {
  if (p.promptId === promptId && p.percent !== lastPercent) {
    lastPercent = p.percent
    console.log('   progress', `${p.percent}%`)
  }
})

const outputPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('执行超时（90s）')), 90_000)
  client.on('executed', (e: { promptId?: string; output?: Record<string, unknown> }) => {
    if (e.promptId === promptId) {
      clearTimeout(timer)
      resolve(e.output ?? {})
    }
  })
  client.on('execution_error', (e: { promptId?: string; message?: string }) => {
    if (e.promptId === promptId) {
      clearTimeout(timer)
      reject(new Error(e.message ?? 'ComfyUI 执行失败'))
    }
  })
})

promptId = await client.submit(workflow)
console.log('3. prompt_id:', promptId)

const output = await outputPromise
const images = (output.images ?? []) as { filename: string; subfolder: string; type: string }[]
console.log('4. executed ->', images.map((i) => i.filename).join(', ') || '(无图片输出)')
if (images.length === 0) {
  client.close()
  console.error('没有拿到输出图片')
  process.exit(1)
}

const dest = path.join(os.tmpdir(), `ff_e2e_${images[0].filename}`)
await client.download(images[0].filename, images[0].subfolder, images[0].type, dest)
const st = await fsp.stat(dest)
console.log('5. downloaded ->', dest, '|', st.size, 'bytes')
client.close()
console.log('E2E OK')
