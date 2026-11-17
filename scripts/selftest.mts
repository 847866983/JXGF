/**
 * 核心逻辑自检（无需 GUI、无需 ComfyUI 在线）。
 * 运行：pnpm test
 * 覆盖：显存档位判定、工作流参数注入、ComfyUI 客户端离线降级、断点续传下载引擎。
 */
import assert from 'node:assert'
import http from 'node:http'
import os from 'node:os'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PRESETS, presetFor } from '../src/main/core/presets.ts'
import { buildWorkflow, extractH3Chain, injectH3RefImages, injectH3RefVideos } from '../src/main/core/workflow.ts'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { collectMediaFiles, collectHistoryFiles, pickFinalMedia } from '../src/main/core/output-files.ts'
import {
  pickQwenT2ITemplate,
  pickQwenEditTemplate,
  buildCharacterT2IInput,
  buildCharacterFourViewInput,
  buildCharacterEditInput
} from '../src/renderer/src/lib/assetGen.ts'
import { buildChatUrl, normalizeAiConfig, defaultAiConfig } from '../src/shared/ai.ts'
import { DownloadManager } from '../src/main/core/download.ts'
import { CATALOG, MODEL_CATALOG, resolveCatalog } from '../src/main/core/catalog.ts'
import { extractArchive } from '../src/main/core/extract.ts'
import { ProjectStore, uid, now } from '../src/main/core/store.ts'
import { listMemory, readMemory, writeMemory, appendMemory } from '../src/main/core/memory.ts'
import { AiAssistant } from '../src/main/core/ai-assistant.ts'
import { explainError } from '../src/renderer/src/lib/errorHelp.ts'
import { ComfyRuntime } from '../src/main/core/comfy-runtime.ts'
import { detectWorkflowKind, isUiWorkflow } from '../src/main/core/workflow-convert.ts'
import { adaptTemplateForGpu } from '../src/main/core/template-adapt.ts'

const execFileAsync = promisify(execFile)

let pass = 0
let fail = 0
function ok(name: string, fn: () => void): void {
  try {
    fn()
    pass += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    fail += 1
    console.error(`FAIL  ${name}`)
    console.error(`      ${String((err as Error).message ?? err)}`)
    process.exitCode = 1
  }
}

// ---- 显存档位 ----
ok('6GB 命中 minimal 档', () => assert.equal(presetFor(6 * 1024).id, 'minimal'))
ok('8GB 命中 entry 档', () => assert.equal(presetFor(8 * 1024).id, 'entry'))
ok('12GB 命中 standard 档', () => assert.equal(presetFor(12 * 1024).id, 'standard'))
ok('16GB 命中 pro 档', () => assert.equal(presetFor(16 * 1024).id, 'pro'))
ok('24GB 命中 flagship 档', () => assert.equal(presetFor(24 * 1024).id, 'flagship'))
ok('3GB 命中 limited 档', () => assert.equal(presetFor(3 * 1024).id, 'limited'))
ok('共 6 档', () => assert.equal(PRESETS.length, 6))
ok('低配档开启 lowvram', () => assert.equal(presetFor(6 * 1024).video.lowvram, true))
ok('旗舰档不开启 lowvram', () => assert.equal(presetFor(24 * 1024).video.lowvram, false))

// ---- 工作流注入 ----
const template = {
  id: 'tpl_test',
  name: 'test',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'positive default' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'negative default' } },
    '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '4': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    '5': { class_type: 'SaveImage', inputs: {} }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}

const wf = buildWorkflow(template, {
  positive: '一只猫在雨中',
  negative: '低质量',
  width: 640,
  height: 360,
  seed: 42
}) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

ok('正向提示词注入第一个文本节点', () => assert.equal(wf['1'].inputs.text, '一只猫在雨中'))
ok('负向提示词注入第二个文本节点', () => assert.equal(wf['2'].inputs.text, '低质量'))
ok('宽度注入 EmptyLatentImage', () => assert.equal(wf['3'].inputs.width, 640))
ok('高度注入 EmptyLatentImage', () => assert.equal(wf['3'].inputs.height, 360))
ok('种子注入 KSampler', () => assert.equal(wf['4'].inputs.seed, 42))
ok('原始节点不被增删', () => assert.equal(Object.keys(wf).length, 5))

// ---- H3 工作流映射 ----
const h3Template = {
  id: 'tpl_h3',
  name: 'h3',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '261': {
      class_type: 'CSGlideCastCS',
      inputs: { h3_data: '{"mode":"ref2va","width":576,"height":320,"length":311}', prompt_text: ['265', 1] }
    },
    '265': {
      class_type: 'CSGlideDeskCS',
      inputs: {
        desk_data: JSON.stringify({ chain: { name: '工程', clip: 'clip_0001', shot: 'clip_0001' }, global: '', segs: { clip_0001: '旧提示词' } })
      }
    },
    '277': { class_type: 'KSampler', inputs: { seed: 12, steps: 4 } }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}

const h3wf = buildWorkflow(h3Template, {
  positive: '新镜头提示词：雨夜古巷',
  width: 640,
  height: 360,
  frames: 49,
  seed: 999,
  mode: 't2v'
}) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

const deskOut = JSON.parse(String(h3wf['265'].inputs.desk_data)) as { segs: Record<string, string> }
ok('H3：提示词写入 desk_data.segs 当前 clip', () => assert.equal(deskOut.segs.clip_0001, '新镜头提示词：雨夜古巷'))
const h3Out = JSON.parse(String(h3wf['261'].inputs.h3_data)) as Record<string, unknown>
ok('H3：h3_data 宽度注入', () => assert.equal(h3Out.width, 640))
ok('H3：h3_data 高度注入', () => assert.equal(h3Out.height, 360))
ok('H3：h3_data 帧数注入', () => assert.equal(h3Out.length, 49))
ok('H3：h3_data 模式注入', () => assert.equal(h3Out.mode, 't2v'))
ok('H3：KSampler 种子注入', () => assert.equal(h3wf['277'].inputs.seed, 999))

// ---- H3 链式续接登记提取 ----
const h3ChainTemplate = {
  id: 'tpl_chain',
  name: 'chain',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: { h3_data: JSON.stringify({ mode: 'ref2va', chain: { name: '未命名工程 42', clip: 'clip_0001', shot: 'xmlekr2' } }) }
    }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
const chainWf = buildWorkflow(h3ChainTemplate, { mode: 'ref2va', frames: 33 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
const chainInfo = extractH3Chain(chainWf)
ok('H3：extractH3Chain 提取工程名', () => assert.equal(chainInfo?.name, '未命名工程 42'))
ok('H3：extractH3Chain 提取 shot', () => assert.equal(chainInfo?.shot, 'xmlekr2'))
ok('H3：buildWorkflow 后 chain 保留（不删）', () => {
  const h3 = JSON.parse(String(chainWf['506'].inputs.h3_data)) as { chain?: { name?: string } }
  assert.equal(h3.chain?.name, '未命名工程 42')
})
ok('H3：非 H3 模板 extractH3Chain 返回 null', () => {
  assert.equal(extractH3Chain({ '1': { class_type: 'KSampler', inputs: {} } }), null)
})

// ---- H3 参考图注入 ----
const rackTemplate = {
  id: 'tpl_rack',
  name: 'rack',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '257': {
      class_type: 'CSGlideH3MediaRackCS',
      inputs: { rack_data: JSON.stringify({ slots: { images: [], videos: [], audios: [] }, cur: 'clip_0001' }) }
    }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
const rackWf = buildWorkflow(rackTemplate, { mode: 'ref2va' }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
injectH3RefImages(rackWf, ['cglide/a.png', 'cglide/b.png'])
const rackOut = JSON.parse(String(rackWf['257'].inputs.rack_data)) as { slots: { images: { file: string }[] } }
ok('H3：参考图注入媒体架 slots.images', () => {
  assert.equal(rackOut.slots.images.length, 2)
  assert.equal(rackOut.slots.images[0].file, 'cglide/a.png')
  assert.equal(rackOut.slots.images[1].file, 'cglide/b.png')
})
ok('H3：空参考图不改变媒体架', () => {
  const t2 = buildWorkflow(rackTemplate, { mode: 'ref2va' }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  injectH3RefImages(t2, [])
  const r = JSON.parse(String(t2['257'].inputs.rack_data)) as { slots: { images: unknown[] } }
  assert.equal(r.slots.images.length, 0)
})

// ---- 离线客户端优雅降级 ----
const client = new ComfyClient('127.0.0.1', 59999)
const stats = await client.systemStats()
ok('离线时 systemStats 返回 online=false', () => assert.equal(stats.online, false))
const q = await client.queueStatus()
ok('离线时 queueStatus 返回 0/0', () => {
  assert.equal(q.queueRunning, 0)
  assert.equal(q.queueRemaining, 0)
})

// ---- 断点续传下载引擎（本地服务器，确定性验证） ----
const payload = Buffer.alloc(256 * 1024)
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
let rangeSeen = false

const server = http.createServer((req, res) => {
  if (req.url === '/file') {
    if (req.headers.range) rangeSeen = true
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    if (m) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Content-Length': payload.length - start,
        'Accept-Ranges': 'bytes'
      })
      res.end(payload.subarray(start))
    } else {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' })
      res.end(payload)
    }
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as { port: number }).port
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-dl-'))

function runDownload(dm: DownloadManager, req: Parameters<DownloadManager['start']>[0]): Promise<{ status: string }> {
  return new Promise((resolve) => {
    const onDone = (): void => {
      cleanup()
      resolve({ status: 'done' })
    }
    const onFail = (): void => {
      cleanup()
      resolve({ status: 'failed' })
    }
    const onCancel = (): void => {
      cleanup()
      resolve({ status: 'cancelled' })
    }
    const cleanup = (): void => {
      dm.off('done', onDone)
      dm.off('failed', onFail)
      dm.off('cancelled', onCancel)
    }
    dm.once('done', onDone)
    dm.once('failed', onFail)
    dm.once('cancelled', onCancel)
    dm.start(req)
  })
}

const dm = new DownloadManager()
const r1 = await runDownload(dm, {
  id: 'full',
  label: '完整下载',
  url: `http://127.0.0.1:${port}/file`,
  dest: path.join(tmp, 'full.bin')
})
ok('下载引擎：完整下载成功', () => assert.equal(r1.status, 'done'))
const gotFull = await fsp.readFile(path.join(tmp, 'full.bin'))
ok('下载引擎：完整下载字节一致', () => assert.equal(gotFull.equals(payload), true))

// 预写前半段 .part，验证断点续传
await fsp.writeFile(path.join(tmp, 'resume.bin.part'), payload.subarray(0, 65536))
const r2 = await runDownload(dm, {
  id: 'resume',
  label: '断点续传',
  url: `http://127.0.0.1:${port}/file`,
  dest: path.join(tmp, 'resume.bin')
})
ok('下载引擎：断点续传成功', () => assert.equal(r2.status, 'done'))
const gotResume = await fsp.readFile(path.join(tmp, 'resume.bin'))
ok('下载引擎：断点续传字节一致', () => assert.equal(gotResume.equals(payload), true))
ok('下载引擎：服务器收到 Range 请求', () => assert.equal(rangeSeen, true))

// SHA256 校验失败 → failed
const badSha = crypto.createHash('sha256').update('wrong').digest('hex')
const r3 = await runDownload(dm, {
  id: 'badsha',
  label: '校验失败',
  url: `http://127.0.0.1:${port}/file`,
  dest: path.join(tmp, 'bad.bin'),
  sha256: badSha
})
ok('下载引擎：SHA256 校验失败标记 failed', () => assert.equal(r3.status, 'failed'))
let partExists = true
try {
  await fsp.stat(path.join(tmp, 'bad.bin.part'))
} catch {
  partExists = false
}
ok('下载引擎：校验失败后清理 part 文件', () => assert.equal(partExists, false))

server.close()
await fsp.rm(tmp, { recursive: true, force: true })

// ---- 组件目录解析 ----
const tmp2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-cat-'))
const nvGpu = { vendor: 'nvidia' as const, name: 'RTX 3060', vramMB: 8192, vramKnown: true, driver: '580', cudaAvailable: true, raw: '' }
const nvLowGpu = { vendor: 'nvidia' as const, name: 'GTX 960', vramMB: 4096, vramKnown: true, driver: '580', cudaAvailable: true, raw: '' }
const amdGpu = { vendor: 'amd' as const, name: 'RX 7800', vramMB: 16384, vramKnown: true, driver: '', cudaAvailable: false, raw: '' }
const intelGpu = { vendor: 'intel' as const, name: 'Arc', vramMB: 8192, vramKnown: true, driver: '', cudaAvailable: false, raw: '' }

ok('目录：NVIDIA 解析出便携版 + 多个推荐模型', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.ok(items.length >= 2)
  assert.equal(items[0].id, 'comfyui-portable-nvidia')
  assert.ok(items.some((i) => i.id === 'wan21-t2v-13b'))
  assert.ok(items.some((i) => i.id === 'z-image-turbo'))
})
ok('目录：NVIDIA 低显存只给便携版（模型被档位过滤）', () => {
  const items = resolveCatalog(tmp2, nvLowGpu)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'comfyui-portable-nvidia')
})
ok('目录：AMD 只解析出 AMD 便携版', () => {
  const items = resolveCatalog(tmp2, amdGpu)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'comfyui-portable-amd')
})
ok('目录：Intel 无可下载组件', () => {
  assert.equal(resolveCatalog(tmp2, intelGpu).length, 0)
})
ok('目录：dest 落在安装根目录下且未安装', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.ok(items[0].dest.startsWith(tmp2))
  assert.equal(items[0].installed, false)
})
ok('目录：模型 dest 落在 models 子目录', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  const wan = items.find((i) => i.id === 'wan21-t2v-13b')!
  assert.ok(wan.dest.includes(path.join('models', 'wan2.1_t2v_1.3B_fp16.safetensors')))
  assert.equal(wan.extract, false)
})
ok('目录：传 comfyModelsRoot 时模型下到 ComfyUI 的 models', () => {
  const items = resolveCatalog(tmp2, nvGpu, 'X:/ComfyUI/models')
  const z = items.find((i) => i.id === 'z-image-turbo')!
  assert.ok(z.dest.toLowerCase().includes('comfyui') && z.dest.includes('z_image_turbo_bf16.safetensors'))
})
ok('目录：便携版需要解压', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.equal(items[0].extract, true)
})
ok('目录：全部 id 唯一且源为 https', () => {
  const ids = new Set([...CATALOG, ...MODEL_CATALOG].map((e) => e.id))
  assert.equal(ids.size, CATALOG.length + MODEL_CATALOG.length)
  for (const e of [...CATALOG, ...MODEL_CATALOG]) {
    assert.ok(e.sources.length > 0)
    for (const s of e.sources) assert.ok(s.url.startsWith('https://'), `${e.id} 源非 https`)
  }
})
ok('目录：Wan 模型三个下载源齐全', () => {
  const m = MODEL_CATALOG.find((e) => e.id === 'wan21-t2v-13b')
  assert.ok(m)
  assert.equal(m.sources.length, 3)
})
await fsp.rm(tmp2, { recursive: true, force: true })

// ---- 解压 ----
const tmp3 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-ext-'))
const srcDir = path.join(tmp3, 'src')
await fsp.mkdir(srcDir)
await fsp.writeFile(path.join(srcDir, 'hello.txt'), 'hello frameforge')
const zipFile = path.join(tmp3, 'pkg.zip')
await execFileAsync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -LiteralPath '${srcDir.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`
])
const outDir = path.join(tmp3, 'out')
await extractArchive(zipFile, outDir)
const extractedText = await fsp.readFile(path.join(outDir, 'src', 'hello.txt'), 'utf8')
ok('解压：zip 解压成功且内容一致', () => assert.equal(extractedText, 'hello frameforge'))

await fsp.writeFile(path.join(tmp3, 'fake.7z'), 'not-a-real-archive')
let extractErr = ''
try {
  await extractArchive(path.join(tmp3, 'fake.7z'), path.join(tmp3, 'out7'), '/nonexistent/7za.exe')
} catch (err) {
  extractErr = String((err as Error).message ?? err)
}
ok('解压：7z 工具缺失给出明确提示', () => assert.match(extractErr, /7z 解压工具不存在|未找到 7z/))

await fsp.writeFile(path.join(tmp3, 'fake.rar'), 'x')
let unsupportedErr = ''
try {
  await extractArchive(path.join(tmp3, 'fake.rar'), path.join(tmp3, 'outrar'))
} catch (err) {
  unsupportedErr = String((err as Error).message ?? err)
}
ok('解压：不支持的格式给出明确提示', () => assert.match(unsupportedErr, /不支持的压缩格式/))

await fsp.rm(tmp3, { recursive: true, force: true })

// ---- 项目存储（JSON 文件即真相） ----
const tmp4 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-store-'))
const store = new ProjectStore(tmp4)
await store.init()
const created = await store.create('测试项目')
const listAfterCreate = await store.list()
ok('store：创建项目后列表有 1 项', () => {
  assert.equal(listAfterCreate.length, 1)
  assert.equal(listAfterCreate[0].name, '测试项目')
})

created.assets.push({
  id: uid('as_'),
  kind: 'character',
  name: '角色A',
  tags: [],
  description: '',
  prompt: '',
  negative: '',
  coverFile: null,
  images: [],
  versions: [],
  createdAt: now(),
  updatedAt: now()
})
await store.save(created)
await store.flush()
const reopened = await store.open(created.id)
ok('store：保存并重开后资产持久化', () => assert.equal(reopened.assets.length, 1))

// 并发 flush 串行化：两个并发的 flush 不应互相覆盖（tmp 文件带时间戳 + 串行队列）
const concStore = new ProjectStore(path.join(tmp4, 'conc'))
await concStore.init()
await concStore.create('并发项目')
const cur = concStore.getCurrent()!
const p1 = (async () => { cur.assets.push({ id: uid('a1_'), kind: 'character', name: 'A', tags: [], description: '', prompt: '', negative: '', coverFile: null, images: [], versions: [], createdAt: now(), updatedAt: now() }); await concStore.flush() })()
const p2 = (async () => { cur.assets.push({ id: uid('a2_'), kind: 'scene', name: 'B', tags: [], description: '', prompt: '', negative: '', coverFile: null, images: [], versions: [], createdAt: now(), updatedAt: now() }); await concStore.flush() })()
await Promise.all([p1, p2])
const reopened2 = await concStore.open(cur.id)
ok('store：并发 flush 串行化不丢数据', () => assert.equal(reopened2.assets.length, 2))
ok('store：重开后项目名一致', () => assert.equal(reopened.name, '测试项目'))
ok('store：重开后 ComfyUI 默认地址 127.0.0.1:8188', () => {
  assert.equal(reopened.settings.comfy.host, '127.0.0.1')
  assert.equal(reopened.settings.comfy.port, 8188)
})

let bakExists = true
try {
  await fsp.stat(path.join(tmp4, created.id, 'project.json.bak'))
} catch {
  bakExists = false
}
ok('store：落盘生成 .bak 备份', () => assert.equal(bakExists, true))

const listAfterSave = await store.list()
ok('store：列表读取到资产与分镜计数', () => {
  assert.equal(listAfterSave[0].assetCount, 1)
  assert.equal(listAfterSave[0].scriptCount, 1)
})
await fsp.rm(tmp4, { recursive: true, force: true })

// ---- 内置 ComfyUI 运行管理 ----
const tmp5 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-rt-'))
const rt = new ComfyRuntime(tmp5)
const cfg0 = await rt.getConfig()
ok('runtime：默认配置 root=null port=8188', () => {
  assert.equal(cfg0.root, null)
  assert.equal(cfg0.port, 8188)
})
await rt.setConfig({ root: 'X:\\FakeComfy', port: 8190, python: null })
const cfg1 = await rt.getConfig()
ok('runtime：配置读写 roundtrip', () => {
  assert.equal(cfg1.root, 'X:\\FakeComfy')
  assert.equal(cfg1.port, 8190)
})

// 伪造便携版目录树
await fsp.mkdir(path.join(tmp5, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true })
await fsp.writeFile(path.join(tmp5, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '')
await fsp.mkdir(path.join(tmp5, 'ComfyUI_windows_portable', 'python_embeded'), { recursive: true })
await fsp.writeFile(path.join(tmp5, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'), '')

const rt2 = new ComfyRuntime(tmp5)
await rt2.setConfig({ root: null, port: 8190, python: null })
ok('runtime：探测到便携版根目录', () => assert.equal(rt2.detectRoots().length, 1))
const st2 = await rt2.status()
ok('runtime：探测到安装时 status=installed', () => {
  assert.equal(st2.status, 'installed')
  assert.ok(st2.root && st2.root.includes('ComfyUI_windows_portable'))
})
const stEmpty = await new ComfyRuntime(path.join(tmp5, 'empty-dir')).status()
ok('runtime：空目录 status=missing', () => assert.equal(stEmpty.status, 'missing'))
await fsp.rm(tmp5, { recursive: true, force: true })

// ---- 工作流格式检测 ----
ok('convert：识别 UI 格式（nodes+links）', () => {
  assert.equal(isUiWorkflow({ nodes: [], links: [] }), true)
  assert.equal(isUiWorkflow({ '1': { class_type: 'KSampler', inputs: {} } }), false)
})
ok('convert：视频工作流识别（含 CSGlide）', () => {
  assert.equal(detectWorkflowKind({ '1': { class_type: 'CSGlideCastCS' }, '2': { class_type: 'KSampler' } }), 'video')
})
ok('convert：图片工作流识别', () => {
  assert.equal(detectWorkflowKind({ '1': { class_type: 'KSampler' }, '2': { class_type: 'SaveImage' } }), 'image')
})

// ---- 记忆库 ----
const memDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jxgf-mem-'))
const memList0 = await listMemory(memDir)
ok('memory：listMemory 返回 5 类记忆且初始不存在', () => {
  assert.equal(memList0.length, 5)
  assert.equal(memList0.every((m) => m.exists === false), true)
  assert.deepEqual(
    memList0.map((m) => m.key),
    ['world', 'characters', 'style', 'continuity', 'decisions']
  )
})
await writeMemory(memDir, 'world', '# 世界观\n\n古代仙侠。')
const worldRead = await readMemory(memDir, 'world')
ok('memory：writeMemory 后 readMemory 内容一致', () => {
  assert.equal(worldRead, '# 世界观\n\n古代仙侠。')
})
const memList1 = await listMemory(memDir)
ok('memory：写入后 world 标记存在', () => {
  const w = memList1.find((m) => m.key === 'world')
  assert.equal(w?.exists, true)
  assert.ok((w?.size ?? 0) > 0)
})
await appendMemory(memDir, 'decisions', '第一条决策：主角黑发')
await appendMemory(memDir, 'decisions', '第二条决策：场景在雨夜')
const dec = await readMemory(memDir, 'decisions')
ok('memory：决策日志只追加，两条都在', () => {
  assert.ok(dec.includes('第一条决策：主角黑发'))
  assert.ok(dec.includes('第二条决策：场景在雨夜'))
})
await writeMemory(memDir, 'world', '# 世界观 v2')
const bakText = await fsp.readFile(path.join(memDir, 'world.md.bak'), 'utf8')
ok('memory：覆盖写入保留 .bak 备份', () => {
  assert.ok(bakText.includes('古代仙侠'))
})
let memThrew = false
try {
  await readMemory(memDir, 'nope')
} catch {
  memThrew = true
}
ok('memory：未知 key 报错', () => assert.equal(memThrew, true))
await fsp.rm(memDir, { recursive: true, force: true })

// ---- AI 助手（用假 LLM 服务验证工具调用循环）----
const aiTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jxgf-ai-'))
const aiStore = new ProjectStore(aiTmp)
await aiStore.init()
await aiStore.create('AI测试项目')
let aiReqs = 0
const aiSrv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    aiReqs += 1
    res.setHeader('Content-Type', 'application/json')
    if (aiReqs === 1) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'create_asset', arguments: JSON.stringify({ kind: 'character', name: '测试角色', prompt: 'a man' }) }
                  }
                ]
              }
            }
          ]
        })
      )
    } else {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已完成，创建了角色。' } }] }))
    }
  })
})
await new Promise<void>((r) => aiSrv.listen(0, '127.0.0.1', () => r()))
const aiPort = (aiSrv.address() as { port: number }).port
const aiAsst = new AiAssistant(aiStore, path.join(process.cwd(), 'skills'))
const aiEvents: string[] = []
const aiRes = await aiAsst.chat(
  { id: 't', name: 't', kind: 'openai', baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: 'm', apiKey: 'x' },
  [{ role: 'user', content: '创建一个角色' }],
  (e) => aiEvents.push(e.type)
)
aiSrv.close()
ok('AI：工具循环返回最终内容', () => assert.ok(aiRes.content.includes('已完成')))
ok('AI：create_asset 工具真的写入了资产', () => assert.equal(aiStore.getCurrent()!.assets.length, 1))
ok('AI：changed 标记为 true', () => assert.equal(aiRes.changed, true))
ok('AI：发出 tool 事件', () => assert.ok(aiEvents.includes('tool')))
await fsp.rm(aiTmp, { recursive: true, force: true })

// ---- 生成参数注入 + 错误诊断 ----
const ksTemplate = {
  id: 'tpl_ks',
  name: 'ks',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
const ksWf = buildWorkflow(ksTemplate, { steps: 8, cfg: 2.5, samplerName: 'res_multistep', scheduler: 'beta' }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
ok('参数：steps 注入 KSampler', () => assert.equal(ksWf['1'].inputs.steps, 8))
ok('参数：cfg 注入 KSampler', () => assert.equal(ksWf['1'].inputs.cfg, 2.5))
ok('参数：sampler 注入 KSampler', () => assert.equal(ksWf['1'].inputs.sampler_name, 'res_multistep'))
ok('参数：scheduler 注入 KSampler', () => assert.equal(ksWf['1'].inputs.scheduler, 'beta'))

// ---- 分段导演台：h3_data 覆盖 / 放大重绘 / 抽帧插帧 ----
const segH3Template = {
  id: 'tpl_h3_seg',
  name: 'h3-seg',
  kind: 'video' as const,
  description: '',
  apiJson: {
    '1': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({
          mode: 'ref2va',
          width: 576,
          height: 320,
          length: 33,
          cont: { mode: 'latent' },
          chain: { name: 'old', clip: 'clip_0001', shot: 'x' }
        })
      }
    },
    '2': { class_type: 'BanZhang_MMH3_Upscale', inputs: { 步数: 2, 去噪强度: 0.45, 音频重绘强度: 0.3, 采样器: 'euler', 调度器: 'simple' } },
    '3': { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模式: '按倍数', 放大倍数: 1, 目标宽度: 1280, 目标高度: 704, 每块帧数: 107, 重叠帧数: 22 } },
    '4': { class_type: 'BanZhang_RIFE_Interpolation', inputs: { 插帧倍数: 2, 序列源帧率: 24, 保留原音: '开' } },
    '5': { class_type: 'CSGlideDeskCS', inputs: { desk_data: JSON.stringify({ chain: { name: 'old', clip: 'clip_0001', shot: 'x' }, segs: { clip_0001: '旧提示词' } }) } }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
const segWf = buildWorkflow(segH3Template, {
  positive: '新的提示词',
  h3: { ratio: '9:16', pin_head: 2, bridge_alpha: 0.7, cont: { mode: 'latent' }, chain: { name: 'E1', clip: 'clip_0002', shot: 's2' } },
  upscale: {
    enabled: true,
    mode: '倍数',
    scale: 2,
    targetWidth: 1280,
    targetHeight: 704,
    steps: 6,
    denoise: 0.5,
    audioDenoise: 0.2,
    sampler: 'res_multistep',
    scheduler: 'beta',
    tileFrames: 64,
    overlapFrames: 16
  },
  rife: { enabled: true, fps: 12, multiplier: 3, keepAudio: false }
}) as Record<string, { inputs: Record<string, unknown> }>
const segH3Out = JSON.parse(String(segWf['1'].inputs.h3_data)) as Record<string, any>
ok('分段：h3 ratio 覆盖', () => assert.equal(segH3Out.ratio, '9:16'))
ok('分段：pin_head 覆盖', () => assert.equal(segH3Out.pin_head, 2))
ok('分段：bridge_alpha 覆盖', () => assert.equal(segH3Out.bridge_alpha, 0.7))
ok('分段：cont 续接保留（不被清除）', () => assert.equal(segH3Out.cont?.mode, 'latent'))
ok('分段：chain 身份写入', () => {
  assert.equal(segH3Out.chain?.name, 'E1')
  assert.equal(segH3Out.chain?.clip, 'clip_0002')
})
ok('H3：提示词写入 h3_data.prompt（驱动画面的关键字段）', () => {
  const pWf = buildWorkflow(h3Template, { positive: '一段暴风雪中的星港调度场景' }) as Record<string, { inputs: Record<string, unknown> }>
  const pData = JSON.parse(String(pWf['261'].inputs.h3_data))
  assert.equal(pData.prompt, '一段暴风雪中的星港调度场景')
})
ok('H3：prompt_text 断线改为直接字符串（确保提示词真正生效）', () => {
  const pWf = buildWorkflow(h3Template, { positive: '星港暴风雪场景' }) as Record<string, { inputs: Record<string, unknown> }>
  assert.equal(pWf['261'].inputs.prompt_text, '星港暴风雪场景')
})
ok('分段：放大重绘步数/去噪注入', () => {
  assert.equal(segWf['2'].inputs['步数'], 6)
  assert.equal(segWf['2'].inputs['去噪强度'], 0.5)
})
ok('分段：放大参数倍数/块帧注入', () => {
  assert.equal(segWf['3'].inputs['放大倍数'], 2)
  assert.equal(segWf['3'].inputs['每块帧数'], 64)
})
ok('分段：关闭放大时去噪/步数仍为安全值（避免除零崩溃）', () => {
  const off = buildWorkflow(segH3Template, {
    upscale: {
      enabled: false,
      mode: '倍数',
      scale: 1,
      targetWidth: 1280,
      targetHeight: 704,
      steps: 0,
      denoise: 0,
      audioDenoise: 0,
      sampler: 'euler',
      scheduler: 'simple',
      tileFrames: 107,
      overlapFrames: 22
    }
  }) as Record<string, { inputs: Record<string, unknown> }>
  assert.ok(Number(off['2'].inputs['步数']) >= 1)
  assert.ok(Number(off['2'].inputs['去噪强度']) > 0)
  assert.ok(Number(off['2'].inputs['音频重绘强度']) > 0)
  assert.equal(off['3'].inputs['放大倍数'], 1)
})
ok('分段：抽帧/插帧注入', () => {
  assert.equal(segWf['4'].inputs['插帧倍数'], 3)
  assert.equal(segWf['4'].inputs['序列源帧率'], 12)
  assert.equal(segWf['4'].inputs['保留原音'], '关')
})
ok('分段：参考视频写入媒体架 videos 槽', () => {
  const rackWf = {
    '1': { class_type: 'CSGlideH3MediaRackCS', inputs: { rack_data: JSON.stringify({ slots: { images: [], videos: [] } }) } }
  } as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  injectH3RefVideos(rackWf, ['prev_seg.mp4'])
  const rack = JSON.parse(String(rackWf['1'].inputs.rack_data))
  assert.equal(rack.slots?.videos?.[0]?.file, 'prev_seg.mp4')
})

ok('分段：desk_data 链与 segs 迁移到新 clip', () => {
  const desk = JSON.parse(String(segWf['5'].inputs.desk_data))
  assert.equal(desk.chain?.clip, 'clip_0002')
  assert.equal(desk.segs?.clip_0002, '新的提示词')
})
ok('分段：t2v 模式清空媒体架参考图残留（h3.mode 传入）', () => {
  const rackTpl = {
    id: 'tpl_t2v',
    name: 't2v',
    kind: 'video' as const,
    description: '',
    apiJson: {
      '1': {
        class_type: 'CSGlideCastCS',
        inputs: { h3_data: JSON.stringify({ mode: 'ref2va', chain: { name: 'E', clip: 'clip_0001', shot: 's' } }) }
      },
      '2': {
        class_type: 'CSGlideH3MediaRackCS',
        inputs: { rack_data: JSON.stringify({ slots: { images: [{ file: 'old.png' }], videos: [], audios: [] }, segs: { clip_0001: { slots: { images: [{ file: 'old.png' }], videos: [], audios: [] } } } }) }
      }
    },
    mapping: { version: 1 },
    createdAt: new Date().toISOString()
  }
  const wf = buildWorkflow(rackTpl, { h3: { mode: 't2v' } }) as Record<string, { inputs: Record<string, unknown> }>
  const rack = JSON.parse(String(wf['2'].inputs.rack_data))
  assert.equal(rack.slots?.images?.length, 0)
  assert.equal(rack.segs?.clip_0001?.slots?.images?.length, 0)
})

ok('错误诊断：显存不足识别', () => {
  const h = explainError('CUDA out of memory. Tried to allocate...')
  assert.ok(h && /显存/.test(h.reason))
})
ok('错误诊断：连接失败识别', () => {
  const h = explainError('fetch failed: connect ECONNREFUSED 127.0.0.1:8188')
  assert.ok(h && /连接/.test(h.reason))
})
ok('错误诊断：未知错误给通用建议', () => {
  const h = explainError('some weird error')
  assert.ok(h && h.suggestion.length > 0)
})
ok('错误诊断：空错误返回 null', () => assert.equal(explainError(''), null))

// ---- 产物提取：history success 时从 outputs 提文件（H3 超时重生成 bug 的根因） ----
ok('产物：collectMediaFiles 从单节点 output 提取视频', () => {
  const files = collectMediaFiles({ videos: [{ filename: 'a.mp4', subfolder: '', type: 'output' }] })
  assert.equal(files.length, 1)
  assert.equal(files[0].filename, 'a.mp4')
})
ok('产物：collectHistoryFiles 从 history 多节点 outputs 提取产物', () => {
  const files = collectHistoryFiles({
    '3': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] },
    '471': { videos: [{ filename: 'seg.mp4', subfolder: 'videos', type: 'output' }] },
    '999': { something_else: 1 }
  })
  assert.equal(files.length, 2)
  assert.ok(files.some((f) => f.filename === 'seg.mp4'))
  assert.ok(files.some((f) => f.filename === 'x.png'))
})
ok('产物：空 outputs 不误判', () => assert.equal(collectHistoryFiles({}).length, 0))
ok('产物：识别 BanZhang painter_output（H3 三采视频，之前一直生成中的根因）', () => {
  const files = collectHistoryFiles({
    '471': { painter_output: [{ filename: '三采_N471_0003.mp4', subfolder: '', type: 'output', src_path: 'D:/comfyui/output/三采_N471_0003.mp4', metadata: { kind: 'video', width: 896, height: 480 } }] }
  })
  assert.equal(files.length, 1)
  assert.equal(files[0].filename, '三采_N471_0003.mp4')
  assert.ok(files[0].src_path)
})

// ---- AI 接口地址解析（网关配了却用不了的根因） ----
ok('AI：base 地址自动拼 /chat/completions', () => {
  assert.equal(buildChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(buildChatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions')
})
ok('AI：完整端点原样使用不重复拼接', () => {
  assert.equal(buildChatUrl('https://gw.example.com/v1/chat/completions'), 'https://gw.example.com/v1/chat/completions')
  assert.equal(buildChatUrl('https://gw.example.com/v1/chat/completions/'), 'https://gw.example.com/v1/chat/completions')
})
ok('AI：裸域名也能拼出端点', () => {
  assert.equal(buildChatUrl('https://gw.example.com'), 'https://gw.example.com/chat/completions')
})
ok('AI：空地址抛错', () => {
  let threw = false
  try {
    buildChatUrl('')
  } catch {
    threw = true
  }
  assert.ok(threw)
})
ok('AI：配置归一化保留自定义 provider', () => {
  const cfg = normalizeAiConfig({
    providers: [{ id: 'gw', name: '我的网关', kind: 'openai', baseUrl: 'https://gw/v1', model: 'm', apiKey: 'k' }],
    activeProviderId: 'gw'
  })
  assert.equal(cfg.providers.length, 1)
  assert.equal(cfg.activeProviderId, 'gw')
  assert.equal(cfg.providers[0].model, 'm')
})
ok('AI：默认配置可用', () => {
  const d = defaultAiConfig()
  assert.ok(d.providers.length > 0)
  assert.ok(d.providers.some((p) => p.id === d.activeProviderId))
})

// ---- 千问图片编辑（CSGlideQwenCastCS） ----
const qwenTpl = {
  id: 'tpl_qwen_edit',
  name: 'qwen-edit',
  kind: 'image' as const,
  description: '',
  apiJson: {
    '245': {
      class_type: 'CSGlideQwenCastCS',
      inputs: {
        qwen_data: JSON.stringify({
          prompt: 'old prompt',
          negative_prompt: 'old neg',
          canvas: { w: 2048, h: 1152 },
          canvas_from_ref: false
        })
      }
    },
    '246': { class_type: 'CSGlideH3MediaRackCS', inputs: { rack_data: JSON.stringify({ slots: { images: [], videos: [], audios: [] } }) } },
    '243': { class_type: 'KSampler', inputs: { seed: 1, steps: 4, cfg: 1.1, sampler_name: 'euler', scheduler: 'normal' } }
  },
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
const qwWf = buildWorkflow(qwenTpl, { positive: '新提示词', negative: '新负面', width: 1024, height: 768 }) as Record<string, { inputs: Record<string, unknown> }>
const qwData = JSON.parse(String(qwWf['245'].inputs.qwen_data)) as Record<string, any>
ok('千问编辑：提示词写入 qwen_data.prompt', () => assert.equal(qwData.prompt, '新提示词'))
ok('千问编辑：负面写入 negative_prompt', () => assert.equal(qwData.negative_prompt, '新负面'))
ok('千问编辑：画布尺寸写入', () => assert.equal(qwData.canvas.w, 1024) && assert.equal(qwData.canvas.h, 768))
ok('千问编辑：采样器参数注入', () => assert.equal(qwWf['243'].inputs.steps, 4))

const qwRefWf = buildWorkflow(qwenTpl, { positive: 'p', refImages: ['ref.png'] }) as Record<string, { inputs: Record<string, unknown> }>
const qwRefData = JSON.parse(String(qwRefWf['245'].inputs.qwen_data)) as Record<string, any>
ok('千问编辑：仅传参考图时画布跟随参考图', () => assert.equal(qwRefData.canvas_from_ref, true))

ok('千问编辑：含 QwenCast 的模板判为图片而非视频', () => {
  const kind = detectWorkflowKind({
    a: { class_type: 'CSGlideQwenCastCS' },
    b: { class_type: 'h3VideoCombine' }
  })
  assert.equal(kind, 'image')
})
ok('H3 三采仍判为视频', () => {
  const kind = detectWorkflowKind({
    a: { class_type: 'CSGlideCastCS' },
    b: { class_type: 'h3VideoCombine' }
  })
  assert.equal(kind, 'video')
})

// ---- 模板显存自适应 ----
const gpu6 = { vendor: 'nvidia' as const, name: 'RTX 2060', vramMB: 6144, vramKnown: true, driver: '', cudaAvailable: true, raw: '' }
const gpu12 = { vendor: 'nvidia' as const, name: 'RTX 3080', vramMB: 12288, vramKnown: true, driver: '', cudaAvailable: true, raw: '' }
const tplApi = {
  a: { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { '放大模型': 'minimax_h3_latent_upscaler_3d_bf16.safetensors', '放大倍数': 1.5, '显存预设': '12 GB' } },
  b: { class_type: 'BanZhang_SLABlockSparseAttention', inputs: { '计算块大小': '64' } },
  c: { class_type: 'BanZhang_MMH3_Upscale', inputs: { '调度器': 'bong_tangent' } }
}
const adapted6 = adaptTemplateForGpu(JSON.parse(JSON.stringify(tplApi)), gpu6) as typeof tplApi
ok('显存自适应：6GB 卡把放大模型换成免模型', () => assert.equal(adapted6.a.inputs['放大模型'], '⚡ 最近邻精确（免模型）'))
ok('显存自适应：6GB 卡放大倍数降为1', () => assert.equal(adapted6.a.inputs['放大倍数'], 1))
ok('显存自适应：6GB 卡显存预设降为6GB', () => assert.equal(adapted6.a.inputs['显存预设'], '6 GB'))
ok('显存自适应：非法调度器改 simple', () => assert.equal(adapted6.c.inputs['调度器'], 'simple'))
const adapted12 = adaptTemplateForGpu(JSON.parse(JSON.stringify(tplApi)), gpu12) as typeof tplApi
ok('显存自适应：12GB 卡不降级模型', () => assert.equal(adapted12.a.inputs['放大模型'], 'minimax_h3_latent_upscaler_3d_bf16.safetensors'))

// ---- 产物选版：H3 三采必须归档「三采」而非「一采」 ----
ok('选版：视频从一采/二采/三采中选出三采', () => {
  const files = [
    { filename: '一采_N467_0009.mp4', subfolder: '', type: 'output' },
    { filename: '二采_N468_0007.mp4', subfolder: '', type: 'output' },
    { filename: '三采_N471_0007.mp4', subfolder: '', type: 'output' }
  ]
  const picked = pickFinalMedia(files, 'video')
  assert.equal(picked.length, 1)
  assert.equal(picked[0].filename, '三采_N471_0007.mp4')
})
ok('选版：没有三采时退回最后一个', () => {
  const files = [
    { filename: '一采_N467_0009.mp4', subfolder: '', type: 'output' },
    { filename: '二采_N468_0007.mp4', subfolder: '', type: 'output' }
  ]
  const picked = pickFinalMedia(files, 'video')
  assert.equal(picked[0].filename, '二采_N468_0007.mp4')
})
ok('选版：图片任务取最后一个', () => {
  const files = [
    { filename: 'a.png', subfolder: '', type: 'output' },
    { filename: 'b.png', subfolder: '', type: 'output' }
  ]
  const picked = pickFinalMedia(files, 'image')
  assert.equal(picked[0].filename, 'b.png')
})
ok('选版：空输入返回空', () => assert.equal(pickFinalMedia([], 'video').length, 0))

// ---- 角色资产三步流程（千问同模型） ----
const qTpl = [
  { id: 't2i', name: 'Qwen-image21-文生图流', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
  { id: 'edit', name: '千问图片编辑(全能编辑)', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
  { id: 'z', name: '01 Z-Image-Turbo', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }
]
const qAsset = { id: 'a', kind: 'character', name: '测试角色', tags: [], description: 'd', prompt: 'p', negative: '', coverFile: null, images: [], versions: [], createdAt: '', updatedAt: '' }
ok('三步：pickQwenT2ITemplate 选中文生图', () => assert.equal(pickQwenT2ITemplate(qTpl).id, 't2i'))
ok('三步：pickQwenEditTemplate 选中编辑', () => assert.equal(pickQwenEditTemplate(qTpl).id, 'edit'))
ok('三步：T2I 不带参考图', () => { const r = buildCharacterT2IInput(qAsset, qTpl); assert.equal(r.templateId, 't2i'); assert.ok(!r.refImages) })
ok('三步：四视图用编辑模板+参考图', () => { const r = buildCharacterFourViewInput(qAsset, qTpl, undefined, 'ref.png'); assert.equal(r.templateId, 'edit'); assert.deepEqual(r.refImages, ['ref.png']) })
ok('三步：编辑用编辑模板+参考图+指令', () => { const r = buildCharacterEditInput(qAsset, qTpl, undefined, 'ref.png', '加红围巾'); assert.equal(r.templateId, 'edit'); assert.deepEqual(r.refImages, ['ref.png']); assert.ok(r.positive.includes('红围巾')) })
ok('三步：缺编辑模板返回 null', () => assert.equal(buildCharacterFourViewInput(qAsset, [qTpl[0]], undefined, 'ref.png'), null))
ok('三步：编辑空指令返回 null', () => assert.equal(buildCharacterEditInput(qAsset, qTpl, undefined, 'ref.png', '  '), null))

// ---- 千问文本编码器提示词注入（不按提示词生成的根因） ----
const qwenInjectTpl = {
  id: 'qwen', name: 'qwen-t2i', kind: 'image' as const, description: '',
  apiJson: {
    '517': { class_type: 'PrimitiveStringMultiline', inputs: { value: '旧提示词' } },
    '522': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['518',0], prompt: ['517',0], negative_prompt: '', resolution: 0 } },
    '515': { class_type: 'KSampler', inputs: { seed: 1, steps: 4, cfg: 1 } }
  },
  mapping: { version: 1 }, createdAt: ''
}
const qwInject = buildWorkflow(qwenInjectTpl, { positive: '全新提示词：机械装甲少女', negative: '低质量' }) as Record<string, { inputs: Record<string, unknown> }>
ok('千问：提示词写入上游 PrimitiveStringMultiline', () => assert.equal(qwInject['517'].inputs.value, '全新提示词：机械装甲少女'))

console.log(`\nselftest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
