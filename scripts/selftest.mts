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
import { buildWorkflow, extractH3Chain, injectH3RefImages } from '../src/main/core/workflow.ts'
import { ComfyClient } from '../src/main/core/comfy.ts'
import { DownloadManager } from '../src/main/core/download.ts'
import { CATALOG, MODEL_CATALOG, resolveCatalog } from '../src/main/core/catalog.ts'
import { extractArchive } from '../src/main/core/extract.ts'
import { ProjectStore, uid, now } from '../src/main/core/store.ts'
import { listMemory, readMemory, writeMemory, appendMemory } from '../src/main/core/memory.ts'
import { AiAssistant } from '../src/main/core/ai-assistant.ts'
import { explainError } from '../src/renderer/src/lib/errorHelp.ts'
import { ComfyRuntime } from '../src/main/core/comfy-runtime.ts'
import { detectWorkflowKind, isUiWorkflow } from '../src/main/core/workflow-convert.ts'

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

ok('目录：NVIDIA 解析出便携版 + 推荐模型', () => {
  const items = resolveCatalog(tmp2, nvGpu)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'comfyui-portable-nvidia')
  assert.equal(items[1].id, 'wan21-t2v-13b')
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
  assert.ok(items[1].dest.includes(path.join('models', 'wan2.1_t2v_1.3B_fp16.safetensors')))
  assert.equal(items[1].extract, false)
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

console.log(`\nselftest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
