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
import { appendRefTags, buildWorkflow, extractH3Chain, injectH3Prompt, injectH3RefImages, injectH3RefVideos } from '../src/main/core/workflow.ts'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { collectMediaFiles, collectHistoryFiles, pickFinalMedia, sanitizeOutputName } from '../src/main/core/output-files.ts'
import {
  pickQwenT2ITemplate,
  pickQwenEditTemplate,
  buildCharacterT2IInput,
  buildCharacterFourViewInput,
  buildCharacterEditInput,
  buildFourViewPositive,
  pickKrea2T2ITemplate,
  pickKrea2EditTemplate,
  pickFourViewTemplate,
  filterRenderableVersions,
  fourViewNegative
} from '../src/renderer/src/lib/assetGen.ts'
import { buildChatUrl, normalizeAiConfig, defaultAiConfig } from '../src/shared/ai.ts'
import { DownloadManager } from '../src/main/core/download.ts'
import { ALL_ENTRIES, MODEL_CATALOG, resolveCatalog } from '../src/main/core/catalog.ts'
import { extractArchive } from '../src/main/core/extract.ts'
import { ProjectStore, uid, now } from '../src/main/core/store.ts'
import { listMemory, readMemory, writeMemory, appendMemory } from '../src/main/core/memory.ts'
import { AiAssistant } from '../src/main/core/ai-assistant.ts'
import { explainError } from '../src/renderer/src/lib/errorHelp.ts'
import { ComfyRuntime } from '../src/main/core/comfy-runtime.ts'
import { detectWorkflowKind, isUiWorkflow } from '../src/main/core/workflow-convert.ts'
import { adaptTemplateForGpu, degradeMissingLoras } from '../src/main/core/template-adapt.ts'
import { listBuiltinWorkflows, loadBuiltinWorkflow, buildBuiltinTemplates } from '../src/main/core/builtin-workflows.ts'
import { collectModelRefs } from '../src/main/core/model-pack.ts'

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
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m && m[2] ? Number(m[2]) : payload.length - 1
    if (m) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes'
      })
      res.end(payload.subarray(start, end + 1))
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

ok('目录：NVIDIA 解析出便携版 + 工作流包', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.ok(items.length >= 2)
  assert.equal(items[0].id, 'comfyui-portable')
  assert.ok(items.some((i) => i.id === 'pack-h3-video'))
  assert.ok(items.some((i) => i.id === 'pack-qwen-image'))
})
ok('目录：NVIDIA 低显存只给便携版', () => {
  const items = resolveCatalog(tmp2, nvLowGpu)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'comfyui-portable')
})
ok('目录：AMD 只解析出便携版', () => {
  const items = resolveCatalog(tmp2, amdGpu)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'comfyui-portable')
})
ok('目录：Intel 只解析出便携版', () => {
  const items = resolveCatalog(tmp2, intelGpu)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'comfyui-portable')
})
ok('目录：dest 落在安装根目录下且未安装', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.ok(items[0].dest!.startsWith(tmp2))
  assert.equal(items[0].installed, false)
})
ok('目录：H3 包模型 dest 落在正确子目录', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  const h3 = items.find((i) => i.id === 'pack-h3-video')!
  assert.equal(h3.files!.length, 6)
  const unet = h3.files!.find((f) => f.file.includes('minimax_h3_hybrid'))!
  assert.ok(unet.dest.includes(path.join('MiniMax-H3', 'minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors')))
  const tae = h3.files!.find((f) => f.file.includes('TAE'))!
  assert.ok(tae.dest.includes('vae_approx'))
})
ok('目录：模型源为原始官方地址（镜像由网络设置改写）', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  const h3 = items.find((i) => i.id === 'pack-h3-video')!
  const first = h3.files![0].sources[0]
  assert.ok(first.url.includes('huggingface.co'), `首源应为官方原始地址: ${first.url}`)
})
ok('目录：传 comfyModelsRoot 时模型下到 ComfyUI 的 models', () => {
  const items = resolveCatalog(tmp2, nvGpu, 'X:/ComfyUI/models')
  const h3 = items.find((i) => i.id === 'pack-h3-video')!
  assert.ok(h3.files![0].dest.toLowerCase().includes('comfyui'))
})
ok('目录：便携版需要解压', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.equal(items[0].extract, true)
})
ok('目录：全部 id 唯一且源为 https', () => {
  const ids = new Set(ALL_ENTRIES.map((e) => e.id))
  assert.equal(ids.size, ALL_ENTRIES.length)
  for (const e of ALL_ENTRIES) {
    const srcs = e.files?.length ? e.files.flatMap((f) => f.sources) : (e.sources ?? [])
    assert.ok(srcs.length > 0, `${e.id} 无下载源`)
    for (const s of srcs) assert.ok(s.url.startsWith('https://'), `${e.id} 源非 https`)
  }
})
ok('目录：H3 包每个文件三个下载源齐全', () => {
  const h3 = MODEL_CATALOG.find((e) => e.id === 'pack-h3-video')
  assert.ok(h3)
  assert.equal(h3.files!.length, 6)
  for (const f of h3.files!) assert.ok(f.sources.length >= 3, `${f.file} 源不足`)
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
ok('三步：四视图用Krea2模板+参考图', () => {
  const krea = [{ id: 'k4', name: '04-Krea2-角色资产四视图', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }]
  const r = buildCharacterFourViewInput(qAsset, krea, undefined, 'ref.png')
  assert.equal(r.templateId, 'k4')
  assert.deepEqual(r.refImages, ['ref.png'])
})
ok('四视图：负向压制投影/地面', () => {
  const n = fourViewNegative()
  assert.ok(/cast shadow/.test(n), '缺少 cast shadow 负词')
  assert.ok(/ground shadow/.test(n), '缺少 ground shadow 负词')
  assert.ok(/floor/.test(n), '缺少 floor 负词')
})
ok('四视图：正向为固定提示词(含no fading)', () => {
  const p = buildFourViewPositive()
  assert.ok(p.startsWith('Convert the character in the image to a Character Sheet'))
  assert.ok(/no fading/.test(p))
})

// ---- 版本列表 ----
ok('版本：过滤空值并去重', () => {
  const v = filterRenderableVersions(['a.png', '', 'a.png', 'b.png'])
  assert.deepEqual(v, ['a.png', 'b.png'])
})
ok('版本：undefined 返回空数组', () => assert.deepEqual(filterRenderableVersions(undefined), []))

// ---- 输出文件名清理（Windows 非法字符导致"生成没反应"） ----
ok('文件名：%date:...% 占位符展开且无冒号', () => {
  const n = sanitizeOutputName('QW21-%date:yyyyMMddhhmmss%_00001_.png')
  assert.ok(!n.includes(':'), '仍含冒号: ' + n)
  assert.ok(/_00001_\.png$/.test(n), '后缀丢失: ' + n)
})
ok('文件名：展开后含时间数字', () => {
  const n = sanitizeOutputName('A-%date:yyyyMMdd%-B', new Date(2026, 10, 17, 9, 8, 7))
  assert.ok(n.includes('20261117'), n)
})
ok('文件名：非法字符替换为下划线', () => {
  const n = sanitizeOutputName('a<b>c:d"e/f\\g|h?i*j.png')
  assert.ok(!/[<>:"/\\|?*]/.test(n), n)
})
ok('文件名：空名兜底', () => assert.equal(sanitizeOutputName(''), 'output'))

// ---- 双引擎 ----
const engTpl = [
  { id: 'q-t2i', name: 'Qwen-image21-文生图流', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
  { id: 'q-edit', name: '千问图片编辑(全能编辑)', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
  { id: 'k-t2i', name: '02-Krea2-单双采', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
  { id: 'k-4v', name: '04-Krea2-角色资产四视图', kind: 'image', apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }
]
ok('双引擎：Krea2文生图模板选中单双采', () => assert.equal(pickKrea2T2ITemplate(engTpl).id, 'k-t2i'))
ok('双引擎：Krea2四视图模板选中04', () => assert.equal(pickFourViewTemplate(engTpl).id, 'k-4v'))
ok('双引擎：千问四视图带多角度LoRA', () => {
  const r = buildCharacterFourViewInput(qAsset, engTpl, undefined, 'ref.png', 'qwen')
  assert.equal(r.templateId, 'q-edit')
  assert.ok(Array.isArray(r.loras) && r.loras.length === 1)
  assert.ok(/multiple_angles/.test(r.loras[0].file))
})
ok('双引擎：Krea2四视图无LoRA且用04模板', () => {
  const r = buildCharacterFourViewInput(qAsset, engTpl, undefined, 'ref.png', 'krea2')
  assert.equal(r.templateId, 'k-4v')
  assert.ok(!r.loras)
})
ok('双引擎：文生图按引擎选模板', () => {
  assert.equal(buildCharacterT2IInput(qAsset, engTpl, undefined, 'krea2').templateId, 'k-t2i')
  assert.equal(buildCharacterT2IInput(qAsset, engTpl, undefined, 'qwen').templateId, 'q-t2i')
})

// ---- H3 模型目录 ----
ok('目录：NVIDIA 8GB 解析出 H3 全套模型（打包）', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  const h3 = items.find((i) => i.id === 'pack-h3-video')
  assert.ok(h3, '缺少 H3 工作流包')
  for (const key of ['minimax_h3_hybrid', 'qwen3vl_32b_minimax', 'video_vae', 'audio_vae', 'TAE', 'h3_upscaler']) {
    assert.ok(h3.files!.some((f) => f.file.includes(key)), '缺少 ' + key)
  }
})
ok('目录：H3 模型 dest 指向正确子目录', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  const h3 = items.find((i) => i.id === 'pack-h3-video')!
  const unet = h3.files!.find((f) => f.file.includes('minimax_h3_hybrid'))!
  assert.ok(unet.dest.includes(path.join('MiniMax-H3', 'minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors')))
  const tae = h3.files!.find((f) => f.file.includes('TAE'))!
  assert.ok(tae.dest.includes('vae_approx'))
})
ok('目录：FFmpeg 工具存在', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.ok(items.some((i) => i.id === 'ffmpeg-essentials'))
})

// ---- 内置工作流 ----
ok('内置工作流：清单非空且含图片+视频', () => {
  const list = listBuiltinWorkflows()
  assert.ok(list.length >= 1, '内置工作流为空')
  assert.ok(list.some((w) => w.kind === 'video'), '缺少视频工作流')
  assert.ok(list.some((w) => w.kind === 'image'), '缺少图片工作流')
})
ok('内置工作流：能加载 apiJson', () => {
  const list = listBuiltinWorkflows()
  const wf = loadBuiltinWorkflow(list[0].file)
  assert.ok(wf && wf.apiJson && typeof wf.apiJson === 'object')
})
ok('内置工作流：空模板列表时全部补入', () => {
  let seq = 0
  const added = buildBuiltinTemplates([], (p) => p + (++seq), () => 'now')
  assert.equal(added.length, listBuiltinWorkflows().length)
})
ok('内置工作流：已存在的同名不重复补', () => {
  const list = listBuiltinWorkflows()
  const existing = [{ id: 'x', name: list[0].name, kind: list[0].kind, apiJson: {}, mapping: { version: 1 }, createdAt: '' } as never]
  const added = buildBuiltinTemplates(existing, (p) => p + Math.random(), () => 'now')
  assert.equal(added.length, listBuiltinWorkflows().length - 1)
})

// ---- 双引擎各自完整的编辑/四视图 ----
ok('双引擎：Krea2有独立编辑模板', () => {
  const list = [
    { id: 'k-edit', name: '05-Krea2-图片编辑', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
    { id: 'k-4v', name: '04-Krea2-角色资产四视图', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }
  ]
  assert.equal(pickKrea2EditTemplate(list).id, 'k-edit', '编辑模板不应选中四视图')
})
ok('双引擎：Krea2编辑走Krea2编辑模板(非四视图)', () => {
  const list = [
    { id: 'k-edit', name: '05-Krea2-图片编辑', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
    { id: 'k-4v', name: '04-Krea2-角色资产四视图', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
    { id: 'q-edit', name: '千问图片编辑(全能编辑)', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }
  ]
  const r = buildCharacterEditInput(qAsset, list, undefined, 'ref.png', '加红围巾', 'krea2')
  assert.equal(r.templateId, 'k-edit')
})
ok('双引擎：千问编辑走千问编辑模板', () => {
  const list = [
    { id: 'k-edit', name: '05-Krea2-图片编辑', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' },
    { id: 'q-edit', name: '千问图片编辑(全能编辑)', kind: 'image' as const, apiJson: {}, mapping: { version: 1 }, createdAt: '', description: '' }
  ]
  const r = buildCharacterEditInput(qAsset, list, undefined, 'ref.png', '加红围巾', 'qwen')
  assert.equal(r.templateId, 'q-edit')
})
ok('四视图：提示词含半身特写+正侧背全身', () => {
  const p = buildFourViewPositive()
  assert.ok(/upper-body half-body portrait/i.test(p), '缺少半身特写')
  assert.ok(/front view, side view and back view/i.test(p), '缺少正侧背全身')
  assert.ok(/facial features/i.test(p), '缺少脸部细节')
})

ok('下载引擎：进度事件被节流(不刷爆IPC)', async () => {
  // 4MB 本地文件，state 事件应远少于未节流的次数
  const p2 = Buffer.alloc(4 * 1024 * 1024)
  for (let i = 0; i < p2.length; i++) p2[i] = i % 251
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m && m[2] ? Number(m[2]) : p2.length - 1
    if (m) { res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${p2.length}`, 'Content-Length': end - start + 1 }); res.end(p2.subarray(start, end + 1)) }
    else { res.writeHead(200, { 'Content-Length': p2.length }); res.end(p2) }
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const pt = (srv.address() as { port: number }).port
  const dm2 = new DownloadManager()
  let emits = 0
  dm2.on('state', () => emits++)
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-thr-'))
  await new Promise<void>((resolve) => {
    dm2.once('done', () => resolve())
    dm2.once('failed', () => resolve())
    dm2.start({ id: 'thr', label: '节流', url: `http://127.0.0.1:${pt}/f`, dest: path.join(dir2, 'x.bin'), parallel: 4 })
  })
  srv.close()
  await fsp.rm(dir2, { recursive: true, force: true })
  assert.ok(emits < 40, `事件过多: ${emits} (应被节流)`)
})
ok('目录：各工作流包源均含官方与镜像两种', () => {
  for (const e of MODEL_CATALOG) {
    for (const f of e.files ?? []) {
      const urls = f.sources.map((s) => s.url)
      assert.ok(urls.some((u) => u.includes('huggingface.co')), `${e.id}/${f.file} 缺官方源`)
      assert.ok(urls.some((u) => u.includes('hf-mirror.com')), `${e.id}/${f.file} 缺镜像源`)
    }
  }
})
ok('网络：applyMirrors 开启 GitHub 加速时加 gh-proxy 前缀', async () => {
  const { applyMirrors } = await import('../src/main/core/network-mirrors.ts')
  const src = [{ name: 'GitHub 官方', url: 'https://github.com/a/b/releases/download/v1/x.7z' }]
  const on = applyMirrors(src, { proxyAddress: '', mirrorPypi: true, mirrorGit: true, mirrorHuggingface: true, mirrorExtensionList: true, githubAcceleration: true })
  assert.ok(on[0].url.startsWith('https://gh-proxy.com/https://github.com/'), `应加加速前缀: ${on[0].url}`)
  const off = applyMirrors(src, { proxyAddress: '', mirrorPypi: true, mirrorGit: true, mirrorHuggingface: true, mirrorExtensionList: true, githubAcceleration: false })
  assert.equal(off[0].url, 'https://github.com/a/b/releases/download/v1/x.7z', '关闭加速时应保持直连')
})
ok('网络：applyMirrors 开启 HF 镜像时把 huggingface.co 改写为 hf-mirror', async () => {
  const { applyMirrors } = await import('../src/main/core/network-mirrors.ts')
  const src = [{ name: 'HuggingFace 官方', url: 'https://huggingface.co/r/m/resolve/main/x.safetensors' }]
  const on = applyMirrors(src, { proxyAddress: '', mirrorPypi: true, mirrorGit: true, mirrorHuggingface: true, mirrorExtensionList: true, githubAcceleration: true })
  assert.ok(on[0].url.includes('hf-mirror.com'), `应改写为镜像: ${on[0].url}`)
  const off = applyMirrors(src, { proxyAddress: '', mirrorPypi: true, mirrorGit: true, mirrorHuggingface: false, mirrorExtensionList: true, githubAcceleration: true })
  assert.ok(off[0].url.includes('huggingface.co'), '关闭镜像时应保持官方')
})
ok('网络：applyMirrors 去重且不重复加 gh-proxy', async () => {
  const { applyMirrors } = await import('../src/main/core/network-mirrors.ts')
  const src = [
    { name: 'GitHub 官方', url: 'https://github.com/a/b/x.7z' },
    { name: 'gh-proxy 加速', url: 'https://gh-proxy.com/https://github.com/a/b/x.7z' }
  ]
  const out = applyMirrors(src, { proxyAddress: '', mirrorPypi: true, mirrorGit: true, mirrorHuggingface: true, mirrorExtensionList: true, githubAcceleration: true })
  assert.equal(out.length, 1, `应去重为 1 个，实际 ${out.length}`)
  assert.ok(out[0].url.startsWith('https://gh-proxy.com/'))
})
ok('目录：H3 六个文件目标名与工作流一致', () => {
  const h3 = MODEL_CATALOG.find((e) => e.id === 'pack-h3-video')!
  const names = h3.files!.map((f) => f.file)
  assert.ok(names.some((n) => n.endsWith('MiniMax-H3/minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors')))
  assert.ok(names.some((n) => n.endsWith('vae/minimax_h3_video_vae_int8_convrot.safetensors')))
  assert.ok(names.some((n) => n.endsWith('vae_approx/MiniMax-H3-TAE.safetensors')))
})

ok('模型搬家：从模板解析引用模型', () => {
  const proj = {
    templates: [
      { name: 'T1', apiJson: { a: { class_type: 'UNETLoader', inputs: { unet_name: 'aaa.safetensors' } }, b: { class_type: 'LoraLoader', inputs: { lora_name: 'sub/bbb.safetensors' } } } }
    ]
  }
  const refs = collectModelRefs(proj as never)
  assert.equal(refs.size, 2)
  assert.ok(refs.has('aaa.safetensors'))
  assert.ok(refs.has('bbb.safetensors'), '应取 basename')
})
ok('模型搬家：忽略非模型文件', () => {
  const proj = { templates: [{ name: 'T', apiJson: { a: { class_type: 'X', inputs: { text: 'hello.png.txt', note: 'abc' } } } }] }
  const refs = collectModelRefs(proj as never)
  assert.equal(refs.size, 0)
})

// ---- 缺失模型降级 ----
ok('缺失降级：不存在的LoRA强度置0', () => {
  const api = { a: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'NOT_EXIST_zzz.safetensors', strength_model: 1 } } }
  const out = degradeMissingLoras(api, tmp2) as typeof api
  assert.equal(out.a.inputs.strength_model, 0)
})
ok('缺失降级：BanZhang LoRA文件缺失置空', () => {
  const api = { a: { class_type: 'BanZhang_LoRA_VramSafe', inputs: { 'LoRA文件': 'NOT_EXIST_yyy.safetensors' } } }
  const out = degradeMissingLoras(api, tmp2) as typeof api
  assert.equal(out.a.inputs['LoRA文件'], '')
})
ok('缺失降级：无modelsRoot时不动', () => {
  const api = { a: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'x.safetensors', strength_model: 1 } } }
  const out = degradeMissingLoras(api, null) as typeof api
  assert.equal(out.a.inputs.strength_model, 1)
})

// ---- H3 参考图注入（参考图不生效的根因回归） ----
/** 构造一个最小 H3 工作流：媒体架(两层 slots) + CSGlideCastCS(h3_data.slots 占位数组) */
function makeH3Fixture(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '257': {
      class_type: 'CSGlideH3MediaRackCS',
      inputs: {
        rack_data: JSON.stringify({
          slots: { images: [], videos: [], audios: [] },
          fps: 0,
          audio_out: 0,
          segs: { clip_0001: { slots: { images: [], videos: [], audios: [] }, fps: 0, audio_out: 0 } },
          cur: 'clip_0001',
          shared: false,
          chain: { name: '', clip: 'clip_0001' }
        })
      }
    },
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({
          mode: 'ref2va',
          prompt: '',
          slots: { first: {}, last: {}, images: [{}, {}, {}, {}, {}, {}, {}, {}, {}], videos: [{}, {}, {}], audios: [{}, {}, {}] },
          chain: { name: 'P', clip: 'clip_0001' }
        }),
        prompt_text: '',
        refs: ['507', 0]
      }
    },
    '507': { class_type: 'CSGlideDeskCS', inputs: { desk_data: JSON.stringify({ chain: { clip: 'clip_0001' }, global: '', segs: {} }), 参考素材: ['257', 0] } }
  }
}

ok('H3参考图：媒体架顶层与当前段两层都写入', () => {
  const wf = makeH3Fixture()
  injectH3RefImages(wf, ['cglide/a.png', 'cglide/b.png'])
  const rack = JSON.parse(String(wf['257'].inputs.rack_data))
  assert.equal(rack.slots.images.length, 2, '顶层 slots.images 应写入')
  assert.equal(rack.segs[rack.cur].slots.images.length, 2, 'segs[cur].slots.images 必须写入（H3 实际读这里）')
  assert.equal(rack.segs[rack.cur].slots.images[0].file, 'cglide/a.png')
})

ok('H3参考图：CSGlideCastCS.h3_data.slots 按占位数组填充', () => {
  const wf = makeH3Fixture()
  injectH3RefImages(wf, ['cglide/a.png', 'cglide/b.png'])
  const h3 = JSON.parse(String(wf['506'].inputs.h3_data))
  assert.equal(h3.slots.images.length, 9, '应保留模板占位长度 9')
  assert.equal(h3.slots.images[0].file, 'cglide/a.png')
  assert.equal(h3.slots.images[1].file, 'cglide/b.png')
  assert.deepEqual(h3.slots.images[2], {}, '未使用的槽位应清空')
})

ok('H3参考视频：媒体架两层 + h3_data.slots.videos 都写入', () => {
  const wf = makeH3Fixture()
  injectH3RefVideos(wf, ['cglide/prev.mp4'])
  const rack = JSON.parse(String(wf['257'].inputs.rack_data))
  assert.equal(rack.slots.videos.length, 1)
  assert.equal(rack.segs[rack.cur].slots.videos.length, 1, 'segs[cur].slots.videos 必须写入')
  const h3 = JSON.parse(String(wf['506'].inputs.h3_data))
  assert.equal(h3.slots.videos[0].file, 'cglide/prev.mp4')
  assert.equal(h3.slots.videos.length, 3, '应保留模板占位长度 3')
})

ok('H3参考图：t2v 清空两层 slots', () => {
  const wf = makeH3Fixture()
  injectH3RefImages(wf, ['cglide/a.png'])
  // 走 buildWorkflow 的 clearH3Refs 路径：构造模板后以 t2v 生成
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', h3: { mode: 't2v' } }) as typeof wf
  const rack = JSON.parse(String(out['257'].inputs.rack_data))
  assert.equal(rack.slots.images.length, 0, 't2v 应清空顶层')
  assert.equal(rack.segs[rack.cur].slots.images.length, 0, 't2v 应清空当前段')
})

// ---- H3 参考图绑定：@图片N 引用（参考图不生效的真正原因） ----
ok('H3参考图绑定：槽位 alias 写入资产名', () => {
  const wf = makeH3Fixture()
  injectH3RefImages(wf, ['cglide/a.png', 'cglide/b.png'], ['安洁拉', '开拓者'])
  const h3 = JSON.parse(String(wf['506'].inputs.h3_data))
  assert.deepEqual(h3.slots.images[0].alias, ['安洁拉'], 'h3_data 槽位 alias 应为资产名')
  assert.deepEqual(h3.slots.images[1].alias, ['开拓者'])
  const rack = JSON.parse(String(wf['257'].inputs.rack_data))
  assert.deepEqual(rack.segs[rack.cur].slots.images[0].alias, ['安洁拉'], '媒体架当前段 alias 也要写')
})

ok('H3参考图绑定：提示词自动补 @图片N', () => {
  const out = appendRefTags('安洁拉走进操纵室', ['cglide/a.png', 'cglide/b.png'])
  assert.ok(out.includes('@图片1'), `应补 @图片1：${out}`)
  assert.ok(out.includes('@图片2'), `应补 @图片2：${out}`)
  assert.ok(out.startsWith('安洁拉走进操纵室'), '原文应保留')
})

ok('H3参考图绑定：补引用时不附资产名（避免自我指涉）', () => {
  const out = appendRefTags('安洁拉走进操纵室', ['cglide/a.png'], ['安洁拉'])
  assert.ok(!out.includes('（安洁拉）'), `不应附资产名，否则 alias 二次展开成 <Picture 1>（<Picture 1>）：${out}`)
})

ok('H3参考图绑定：已有 @图片N 时不重复插入', () => {
  const once = appendRefTags('场景描述', ['cglide/a.png'])
  const twice = appendRefTags(once, ['cglide/a.png'])
  assert.equal(twice, once, '重复调用不应再追加')
  const withPic = appendRefTags('从 <Picture 1> 开始', ['cglide/a.png'])
  assert.ok(!withPic.includes('参考素材'), `已写 <Picture 1> 时不应再加：${withPic}`)
})

ok('H3参考图绑定：buildWorkflow 开启 alias 模式', () => {
  const wf = makeH3Fixture()
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', mode: 'ref2va' }) as typeof wf
  const h3 = JSON.parse(String(out['506'].inputs.h3_data))
  assert.equal(h3.alias, true, 'h3_data.alias 必须为 true，否则角色名不会展开成 @图片N')
})

// ---- 工作流作者参数保护：不擅自改写模板配置 ----
ok('模板保护：未改采样参数时保留 SelfLift 分段步数原值', () => {
  // 模板：KSampler steps=4，SelfLift 分段步数=3,3（作者刻意配的，合计≠steps）
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    },
    '277': { class_type: 'KSampler', inputs: { seed: 8, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'beta', denoise: 1 } },
    '431': { class_type: 'BanZhang_SelfLiftMultiStage', inputs: { 分段步数: '3,3', 级间倍率: 1.5 } }
  }
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  // 采样参数与模板一致 → keepTemplateSampler=true
  const out = buildWorkflow(tpl as never, {
    positive: 'p',
    steps: 4,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'beta',
    keepTemplateSampler: true
  }) as typeof wf
  assert.equal(out['431'].inputs['分段步数'], '3,3', '未改参数时必须保留作者的 3,3')
  assert.equal(out['277'].inputs.steps, 4)
})

ok('模板保护：用户改了步数时按新 steps 重算分段步数', () => {
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    },
    '277': { class_type: 'KSampler', inputs: { seed: 8, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'beta', denoise: 1 } },
    '431': { class_type: 'BanZhang_SelfLiftMultiStage', inputs: { 分段步数: '3,3', 级间倍率: 1.5 } }
  }
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  // 用户把 steps 改成 6 → 应重算成 3,3（6/2=3）
  const out = buildWorkflow(tpl as never, {
    positive: 'p',
    steps: 6,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'beta'
  }) as typeof wf
  assert.equal(out['277'].inputs.steps, 6)
  assert.equal(out['431'].inputs['分段步数'], '3,3', '6 步应重算为 3,3')
})

ok('模板保护：一采采样参数原样保留(seed8/steps4/cfg1/euler/beta/denoise1)', () => {
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    },
    '277': { class_type: 'KSampler', inputs: { seed: 8, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'beta', denoise: 1 } }
  }
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  const out = buildWorkflow(tpl as never, {
    positive: 'p',
    steps: 4,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'beta',
    keepTemplateSampler: true
  }) as typeof wf
  const ks = out['277'].inputs
  assert.equal(ks.seed, 8)
  assert.equal(ks.steps, 4)
  assert.equal(ks.cfg, 1)
  assert.equal(ks.sampler_name, 'euler')
  assert.equal(ks.scheduler, 'beta')
  assert.equal(ks.denoise, 1)
})

console.log(`\nselftest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
