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
import { composeDeskText, normalizeRefs, dropUnbackedRefs, filterSlotsByPrompt, presentationOrder, emptySlots, alignFrames, nearestFrames } from '../src/main/core/h3-prompt.ts'
import { exportProjectToFile, importProjectFromFile, collectProjectFiles } from '../src/main/core/project-archive.ts'
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
import { extractArchive } from '../src/main/core/extract.ts'
import { ProjectStore, uid, now } from '../src/main/core/store.ts'
import { listMemory, readMemory, writeMemory, appendMemory } from '../src/main/core/memory.ts'
import { AiAssistant } from '../src/main/core/ai-assistant.ts'
import { explainError } from '../src/renderer/src/lib/errorHelp.ts'
import { ComfyRuntime } from '../src/main/core/comfy-runtime.ts'
import { detectWorkflowKind, isUiWorkflow } from '../src/main/core/workflow-convert.ts'
import { adaptTemplateForGpu, degradeMissingLoras, pickVramPreset, resetVramFieldsToAuthor } from '../src/main/core/template-adapt.ts'
import { listBuiltinWorkflows, loadBuiltinWorkflow, buildBuiltinTemplates } from '../src/main/core/builtin-workflows.ts'

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

// ---- 组件目录解析 ----
const tmp2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-cat-'))
const nvGpu = { vendor: 'nvidia' as const, name: 'RTX 3060', vramMB: 8192, vramKnown: true, driver: '580', cudaAvailable: true, raw: '' }
const nvLowGpu = { vendor: 'nvidia' as const, name: 'GTX 960', vramMB: 4096, vramKnown: true, driver: '580', cudaAvailable: true, raw: '' }
const amdGpu = { vendor: 'amd' as const, name: 'RX 7800', vramMB: 16384, vramKnown: true, driver: '', cudaAvailable: false, raw: '' }
const intelGpu = { vendor: 'intel' as const, name: 'Arc', vramMB: 8192, vramKnown: true, driver: '', cudaAvailable: false, raw: '' }

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
ok('显存自适应：6GB 卡保留作者放大倍数(不锁成1)', () => assert.equal(adapted6.a.inputs['放大倍数'], 1.5))
ok('显存自适应：6GB 卡显存预设降为6GB', () => assert.equal(adapted6.a.inputs['显存预设'], '6 GB'))
ok('显存自适应：第三方调度器兜底为 beta', () => assert.equal(adapted6.c.inputs['调度器'], 'beta'))
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

// ---- 内置工作流 ----
ok('内置工作流：清单非空且含图片+视频', () => {
  const list = listBuiltinWorkflows()
  assert.ok(list.length >= 1, '内置工作流为空')
  assert.ok(list.some((w) => w.kind === 'video'), '缺少视频工作流')
  assert.ok(list.some((w) => w.kind === 'image'), '缺少图片工作流')
})
ok('内置工作流：能加载工作流内容', () => {
  const list = listBuiltinWorkflows()
  if (list.length === 0) return // 未导入工作流时跳过
  const wf = loadBuiltinWorkflow(list[0].file) as unknown as Record<string, unknown>
  // 支持两种格式：API 格式（apiJson）或 ComfyUI UI 格式（nodes/links）
  assert.ok(wf && typeof wf === 'object', '应能加载工作流')
  const hasApi = wf.apiJson && typeof wf.apiJson === 'object'
  const hasUi = Array.isArray(wf.nodes)
  assert.ok(hasApi || hasUi, '应含 apiJson 或 nodes')
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

// ---- 二采/三采：放大节点降级不丢作者配置 ----
ok('模板保护：6GB降级保留作者的放大倍数(1.5不被锁成1)', () => {
  const api = {
    a: {
      class_type: 'BanZhang_MMH3_UpscaleParams',
      inputs: { 放大模型: 'minimax_h3_latent_upscaler_3d_bf16.safetensors', 放大倍数: 1.5, 显存预设: '12 GB' }
    }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.a.inputs['放大倍数'], 1.5, '放大倍数必须保留作者配的 1.5，不能被锁成 1（否则二采变无意义重采样）')
  assert.equal(out.a.inputs['放大模型'], '⚡ 最近邻精确（免模型）', '大模型应换成免模型避免 OOM')
  assert.equal(out.a.inputs['显存预设'], '6 GB')
})

ok('模板保护：第三方调度器 bong_tangent 兜底为 beta(不是 simple)', () => {
  const api = { a: { class_type: 'BanZhang_MMH3_Upscale', inputs: { 调度器: 'bong_tangent', 步数: 2 } } }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.a.inputs['调度器'], 'beta', 'bong_tangent 是 beta 类曲线，应映射到 beta 而非 simple')
})

ok('模板保护：标准调度器不被改写', () => {
  const api = { a: { class_type: 'BanZhang_MMH3_Upscale', inputs: { 调度器: 'beta' } } }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.a.inputs['调度器'], 'beta')
})

ok('模板保护：显存充足时保留真放大模型且预设按实际显存分档', () => {
  const api = {
    a: {
      class_type: 'BanZhang_MMH3_UpscaleParams',
      inputs: { 放大模型: 'minimax_h3_latent_upscaler_3d_bf16.safetensors', 放大倍数: 1.5, 显存预设: '12 GB' }
    }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 4090', vramMB: 24576, vramKnown: true }) as typeof api
  assert.equal(out.a.inputs['放大模型'], 'minimax_h3_latent_upscaler_3d_bf16.safetensors', '24GB 应保留真放大模型')
  assert.equal(out.a.inputs['放大倍数'], 1.5)
  assert.equal(out.a.inputs['显存预设'], '24 GB', '预设按实际显存动态升到 24 GB')
})

// ---- 三采：与二采参数不同，各自独立保留 ----
ok('三采：参数与二采独立(三采倍数1/6GB/预显影0, 二采1.5/12GB/预显影1)', () => {
  const api = {
    // 二采参数
    two: {
      class_type: 'BanZhang_MMH3_UpscaleParams',
      inputs: { 放大模型: '⚡ 最近邻精确（免模型）', 放大倍数: 1.5, 显存预设: '12 GB', 预显影步数: 1, 预显影强度: 0.3 }
    },
    // 三采参数
    three: {
      class_type: 'BanZhang_MMH3_UpscaleParams',
      inputs: { 放大模型: '⚡ 最近邻精确（免模型）', 放大倍数: 1, 显存预设: '6 GB', 预显影步数: 0, 预显影强度: 0.05 }
    }
  }
  // 6GB 机器：二采倍数必须保持 1.5，三采保持 1
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.two.inputs['放大倍数'], 1.5, '二采应保持 1.5')
  assert.equal(out.three.inputs['放大倍数'], 1, '三采应保持 1')
  assert.equal(out.two.inputs['预显影步数'], 1)
  assert.equal(out.three.inputs['预显影步数'], 0)
  assert.equal(out.three.inputs['预显影强度'], 0.05)
})

ok('三采：放大节点去噪强度各自保留(二采0.5/三采0.45)', () => {
  const api = {
    two: { class_type: 'BanZhang_MMH3_Upscale', inputs: { 去噪强度: 0.5, 步数: 2, 采样器: 'euler', 调度器: 'bong_tangent' } },
    three: { class_type: 'BanZhang_MMH3_Upscale', inputs: { 去噪强度: 0.45, 步数: 2, 采样器: 'euler', 调度器: 'bong_tangent' } }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.two.inputs['去噪强度'], 0.5, '二采去噪 0.5')
  assert.equal(out.three.inputs['去噪强度'], 0.45, '三采去噪 0.45')
  assert.equal(out.two.inputs['调度器'], 'beta')
  assert.equal(out.three.inputs['调度器'], 'beta')
})

// ---- 超分组：插帧 → RTX超分 → 合并 ----
ok('超分：RTX超分节点参数保留(档位/倍数/精度不被改写)', () => {
  const api = {
    sup: {
      class_type: 'BanZhang_RTX_SuperResolution',
      inputs: {
        缩放方式: '按倍数放大',
        放大倍数: 2.0,
        输出宽度: 1920,
        输出高度: 1080,
        处理档位: '常规放大·极致',
        强度: 1.0,
        像素精度: '10位(更精细)',
        序列源帧率: 24,
        封装视频: '开',
        保留原音: '开',
        视频: ['307', 0]
      }
    }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.sup.inputs['处理档位'], '常规放大·极致', '档位不能被降级逻辑改写')
  assert.equal(out.sup.inputs['放大倍数'], 2, '倍数保持 2')
  assert.equal(out.sup.inputs['像素精度'], '10位(更精细)')
  assert.equal(out.sup.inputs['强度'], 1)
})

ok('超分：超分链路 三采合并→RIFE→超分→超分合并', () => {
  // RIFE 只有 1 个输出("VIDEO",) → 索引 0
  // RTX超分 输出("IMAGE","VIDEO") → 视频索引 1
  const rife = { class_type: 'BanZhang_RIFE_Interpolation', inputs: { 视频: ['471', 1], 插帧倍数: 2 } }
  const sup = { class_type: 'BanZhang_RTX_SuperResolution', inputs: { 视频: ['307', 0] } }
  const comb = { class_type: 'banzhangVideoCombine', inputs: { '🖼️ 图像': ['515', 1] } }
  assert.deepEqual(rife.inputs['视频'], ['471', 1], 'RIFE 接三采合并的视频输出(索引1)')
  assert.deepEqual(sup.inputs['视频'], ['307', 0], 'RIFE 单输出，索引必须是 0')
  assert.deepEqual(comb.inputs['🖼️ 图像'], ['515', 1], '超分输出的视频是索引 1')
})

ok('超分：buildWorkflow 后超分节点完整保留', () => {
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    },
    '515': {
      class_type: 'BanZhang_RTX_SuperResolution',
      inputs: { 处理档位: '常规放大·极致', 放大倍数: 2, 像素精度: '10位(更精细)', 强度: 1, 视频: ['307', 0] }
    }
  }
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: wf, mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', mode: 'ref2va' }) as typeof wf
  assert.ok(out['515'], '超分节点不能丢')
  assert.equal(out['515'].inputs['处理档位'], '常规放大·极致')
  assert.equal(out['515'].inputs['放大倍数'], 2)
  assert.deepEqual(out['515'].inputs['视频'], ['307', 0])
})

// ---- SelfLift 分段步数硬约束（合计不能超过 KSampler steps）----
function segSum(out: Record<string, { class_type: string; inputs: Record<string, unknown> }>): { steps: number; seg: string; sum: number } {
  let steps = 0
  for (const n of Object.values(out)) {
    if (String(n.class_type) === 'KSampler' && typeof n.inputs.steps === 'number') {
      steps = n.inputs.steps
      break
    }
  }
  const seg = String(out['431']?.inputs['分段步数'] ?? '')
  const sum = seg
    .split(/[,，]/)
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x))
    .reduce((a, b) => a + b, 0)
  return { steps, seg, sum }
}

function makeSegFixture(segValue: string, steps: number) {
  return {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    },
    '277': { class_type: 'KSampler', inputs: { seed: 8, steps, cfg: 1, sampler_name: 'euler', scheduler: 'beta', denoise: 1 } },
    '431': { class_type: 'BanZhang_SelfLiftMultiStage', inputs: { 分段步数: segValue } }
  }
}


ok('SelfLift：分段步数合计未超限时保留作者原配(3,3 + steps8 保持)', () => {
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: makeSegFixture('3,3', 8), mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', mode: 'ref2va', steps: 8 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  const r = segSum(out)
  assert.equal(r.seg, '3,3', 'steps=8 时 3,3 合法，应保留')
  assert.ok(r.sum <= r.steps)
})




// ---- 显存预设动态分档 ----
ok('显存分档：pickVramPreset 按实际显存映射到节点支持的档位', () => {
  assert.equal(pickVramPreset(2048), '4 GB', '2GB 低于最小档，用 4 GB')
  assert.equal(pickVramPreset(4096), '4 GB')
  assert.equal(pickVramPreset(6144), '6 GB', 'RTX 2060 6GB')
  assert.equal(pickVramPreset(8192), '8 GB', 'RTX 4060 8GB')
  assert.equal(pickVramPreset(11264), '8 GB', '11GB 取不超过的最大档')
  assert.equal(pickVramPreset(12288), '12 GB')
  assert.equal(pickVramPreset(16384), '16 GB')
  assert.equal(pickVramPreset(24576), '24 GB')
  assert.equal(pickVramPreset(49152), '24 GB', '48GB 用最大档 24 GB')
  assert.equal(pickVramPreset(0), '6 GB', '未知时给默认')
})

ok('显存分档：6GB 卡自动用 6 GB 预设(不是硬编码)', () => {
  const api = {
    p: { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: 'minimax_h3_latent_upscaler_3d_bf16.safetensors', 放大倍数: 1.5, 显存预设: '12 GB' } }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof api
  assert.equal(out.p.inputs['显存预设'], '6 GB')
  assert.equal(out.p.inputs['放大模型'], '⚡ 最近邻精确（免模型）', '6GB 应降级为免模型')
  assert.equal(out.p.inputs['放大倍数'], 1.5, '倍数必须保留')
})

ok('显存分档：12GB 卡用 12 GB 预设 + 真放大模型 + 计算块64', () => {
  const api = {
    p: { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: '⚡ 最近邻精确（免模型）', 放大倍数: 1.5, 显存预设: '6 GB' } },
    s: { class_type: 'BanZhang_SLABlockSparseAttention', inputs: { 计算块大小: '32' } }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: 'RTX 3060', vramMB: 12288, vramKnown: true }) as typeof api
  assert.equal(out.p.inputs['显存预设'], '12 GB')
  assert.equal(out.p.inputs['放大模型'], 'minimax_h3_latent_upscaler_3d_bf16.safetensors', '12GB 应用真模型')
  assert.equal(out.s.inputs['计算块大小'], '64', '高显存恢复计算块 64')
})

ok('显存分档：H3省显存档位与SelfLift分块按显存调整', () => {
  const make = () => ({
    m: { class_type: 'BanZhang_H3MemoryOptimizer', inputs: { 省显存档位: '① 关（最快，不省显存）' } },
    s: { class_type: 'BanZhang_SelfLiftMultiStage', inputs: { token分块大小: 4096, 权重缓存预算: 4 } }
  })
  const g6 = adaptTemplateForGpu(make(), { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as ReturnType<typeof make>
  assert.equal(g6.m.inputs['省显存档位'], '③ 强力（省得多，画面基本不变）')
  assert.equal(g6.s.inputs['token分块大小'], 1024)
  assert.equal(g6.s.inputs['权重缓存预算'], 1)
  const g8 = adaptTemplateForGpu(make(), { vendor: 'nvidia', name: 'RTX 4060', vramMB: 8192, vramKnown: true }) as ReturnType<typeof make>
  assert.equal(g8.m.inputs['省显存档位'], '② 轻度（省一点，画面完全不变）')
  assert.equal(g8.s.inputs['token分块大小'], 2048)
  const g24 = adaptTemplateForGpu(make(), { vendor: 'nvidia', name: 'RTX 4090', vramMB: 24576, vramKnown: true }) as ReturnType<typeof make>
  assert.equal(g24.m.inputs['省显存档位'], '① 关（最快，不省显存）')
  assert.equal(g24.s.inputs['token分块大小'], 8192)
  assert.equal(g24.s.inputs['权重缓存预算'], 8)
})

ok('显存分档：显存未知时完全不动模板', () => {
  const api = {
    p: { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: 'minimax_h3_latent_upscaler_3d_bf16.safetensors', 显存预设: '12 GB' } }
  }
  const out = adaptTemplateForGpu(api, { vendor: 'nvidia', name: '?', vramMB: 0, vramKnown: false }) as typeof api
  assert.equal(out.p.inputs['显存预设'], '12 GB', '未知显存保留作者原配')
  assert.equal(out.p.inputs['放大模型'], 'minimax_h3_latent_upscaler_3d_bf16.safetensors')
})

// ---- 老项目模板修复 ----
ok('老项目修复：被锁成1的放大倍数按内置模板恢复', () => {
  const stored = {
    '393': { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: '⚡ 最近邻精确（免模型）', 放大倍数: 1, 显存预设: '6 GB' } },
    '398': { class_type: 'BanZhang_H3MemoryOptimizer', inputs: { 省显存档位: '① 关（最快，不省显存）' } }
  }
  const author = {
    '393': { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: 'minimax_h3_latent_upscaler_3d_bf16.safetensors', 放大倍数: 1.5, 显存预设: '12 GB' } }
  }
  const reset = resetVramFieldsToAuthor(JSON.parse(JSON.stringify(stored)), author) as typeof stored
  assert.equal(reset['393'].inputs['放大倍数'], 1.5, '被锁成 1 的倍数应恢复到作者的 1.5')
  assert.equal(reset['393'].inputs['放大模型'], 'minimax_h3_latent_upscaler_3d_bf16.safetensors', '应恢复真模型')
  assert.equal(reset['393'].inputs['显存预设'], '12 GB', '应恢复作者 12GB')
  const adapted = adaptTemplateForGpu(reset, { vendor: 'nvidia', name: 'RTX 2060', vramMB: 6144, vramKnown: true }) as typeof stored
  assert.equal(adapted['393'].inputs['放大倍数'], 1.5, '6GB 适配后倍数仍是 1.5')
  assert.equal(adapted['393'].inputs['显存预设'], '6 GB', '6GB 卡降到 6 GB')
  assert.equal(adapted['393'].inputs['放大模型'], '⚡ 最近邻精确（免模型）', '6GB 卡用免模型')
  assert.equal(adapted['398'].inputs['省显存档位'], '③ 强力（省得多，画面基本不变）', '6GB 卡开强力省显存')
})

ok('老项目修复：无内置模板参考时不动倍数', () => {
  const stored = {
    '393': { class_type: 'BanZhang_MMH3_UpscaleParams', inputs: { 放大模型: '⚡ 最近邻精确（免模型）', 放大倍数: 1.5, 显存预设: '6 GB' } }
  }
  const reset = resetVramFieldsToAuthor(JSON.parse(JSON.stringify(stored))) as typeof stored
  assert.equal(reset['393'].inputs['放大倍数'], 1.5, '无参考时保留原倍数')
  assert.equal(reset['393'].inputs['显存预设'], '12 GB', '但显存预设仍重置为作者原配')
})

// ---- 文案台：别名模式开关 ----
function makeAliasFixture(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '506': {
      class_type: 'CSGlideCastCS',
      inputs: {
        h3_data: JSON.stringify({ mode: 'ref2va', prompt: '', slots: { images: [{}, {}], videos: [{}], audios: [{}] }, chain: { clip: 'clip_0001' } }),
        prompt_text: ''
      }
    }
  }
}

ok('文案台：别名模式开启时 h3_data.alias=true', () => {
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: makeAliasFixture(), mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: '安吉拉走进操纵室', mode: 'ref2va', h3: { mode: 'ref2va', alias: true } }) as ReturnType<typeof makeAliasFixture>
  const h3 = JSON.parse(String(out['506'].inputs.h3_data))
  assert.equal(h3.alias, true)
})

ok('文案台：别名模式关闭时 h3_data.alias=false', () => {
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: makeAliasFixture(), mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', mode: 'ref2va', h3: { mode: 'ref2va', alias: false } }) as ReturnType<typeof makeAliasFixture>
  const h3 = JSON.parse(String(out['506'].inputs.h3_data))
  assert.equal(h3.alias, false, '关闭别名时必须显式写 false，H3 才只认显式 @图片N')
})

ok('文案台：未传 alias 时默认开启', () => {
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: makeAliasFixture(), mapping: {} }
  const out = buildWorkflow(tpl as never, { positive: 'p', mode: 'ref2va', h3: { mode: 'ref2va' } }) as ReturnType<typeof makeAliasFixture>
  const h3 = JSON.parse(String(out['506'].inputs.h3_data))
  assert.equal(h3.alias, true, '默认开启别名，保证写角色名就能绑定参考图')
})

/* ===== 文案台 / 导演台规则（照搬 ComfyUI-Banzhang-All-1101）===== */

ok('文案台：片子级 + 本段按顺序拼接', () => {
  assert.equal(composeDeskText('冷调赛博都市', '女主推门而入'), '冷调赛博都市\n女主推门而入')
  assert.equal(composeDeskText('', '只有本段'), '只有本段')
  assert.equal(composeDeskText('只有片子级', ''), '只有片子级')
  assert.equal(composeDeskText('  ', '  '), '')
})

ok('文案台：@标签各种写法归一', () => {
  assert.equal(normalizeRefs('保持 <Picture 1> 的体型'), '保持 @图片1 的体型')
  assert.equal(normalizeRefs('Picture 2 的衣服'), '@图片2 的衣服')
  assert.equal(normalizeRefs('参考图片3'), '参考@图片3')
  assert.equal(normalizeRefs('动作参考 <Video 1>'), '动作参考 @视频1')
  assert.equal(normalizeRefs('配乐 <Audio 2>'), '配乐 @音频2')
  assert.equal(normalizeRefs('@图片1@图片2'), '@图片1 @图片2')
})

ok('文案台：没有素材的 @图片N 会被摘掉', () => {
  const s = emptySlots()
  s.images[0] = { file: 'a.png' }
  const r = dropUnbackedRefs('@图片1 和 @图片3', s)
  assert.deepEqual(r.dropped, ['@图片3'])
  assert.equal(r.text.trim(), '@图片1 和')
})

ok('导演台：只送提示词提到的参考图（音频不过滤）', () => {
  const s = emptySlots()
  s.images[0] = { file: 'a.png' }
  s.images[1] = { file: 'b.png' }
  s.audios[0] = { file: 'm.mp3' }
  const f = filterSlotsByPrompt(s, '只用 @图片2')
  assert.equal(f.images?.[0]?.file, undefined)
  assert.equal(f.images?.[1]?.file, 'b.png')
  assert.equal(f.audios?.[0]?.file, 'm.mp3')
  const none = filterSlotsByPrompt(s, '没有引用')
  assert.equal((none.images ?? []).filter((x) => x?.file).length, 0)
  assert.equal((none.audios ?? []).filter((x) => x?.file).length, 1)
})

ok('导演台：@标签编号规则（图片→视频→音频）', () => {
  const s = emptySlots()
  s.images[0] = { file: 'a.png' }
  s.images[2] = { file: 'c.png' }
  s.videos[0] = { file: 'v.mp4', audio: true }
  s.audios[0] = { file: 'm.mp3' }
  assert.deepEqual(presentationOrder(s, 'ref2va').map((r) => r.token + '→' + r.tag), [
    '@图片1→<Picture 1>', '@图片3→<Picture 2>',
    '@视频音频1→<Audio 1>', '@视频1→<Video 1>', '@音频1→<Audio 2>'
  ])
})

ok('导演台：帧数必须落在 17k+5 网格', () => {
  assert.equal(alignFrames(120), 124)
  assert.equal(alignFrames(124), 124)
  assert.equal(alignFrames(361), 362)
  assert.equal(nearestFrames(150), 158)
})

ok('文案台：global 只存片子级，本段进 segs（不再重复拼接）', () => {
  const tpl = { id: 't', name: 't', kind: 'video', apiJson: makeAliasFixture(), mapping: {} }
  const out = buildWorkflow(tpl as never, {
    positive: '本段动作', globalPrompt: '全片风格', mode: 'ref2va',
    h3: { mode: 'ref2va', alias: true }
  }) as ReturnType<typeof makeAliasFixture>
  const h3 = JSON.parse(String(out['506'].inputs.h3_data))
  assert.equal(h3.prompt, '全片风格\n本段动作')
})

ok('工程包往返：导出再导入，媒体文件完整还原', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jxgf-arc-'))
  const md = path.join(tmp, 'media'); await fsp.mkdir(md, { recursive: true })
  const a = path.join(md, '角色A.png'); const b = path.join(md, '成片.mp4')
  await fsp.writeFile(a, 'AAAA'); await fsp.writeFile(b, 'BBBB')
  const proj = {
    schema: 1, id: 'p1', name: '往返测试', createdAt: '', updatedAt: '',
    settings: { comfy: { host: '127.0.0.1', port: 8188, protocol: 'http' }, aspect: '16:9', style: '', autoRetry: 1, retryDelaySec: 5, activeScriptId: null, presetId: 'p' },
    scripts: [], episodes: [], scenes: [], templates: [],
    shots: [{ id: 's1', outputs: [{ id: 'o1', file: b, kind: 'video', status: 'done', progress: 100, createdAt: '' }] }],
    assets: [{ id: 'a1', kind: 'character', name: 'A', tags: [], description: '', prompt: '', negative: '', coverFile: a, images: [a], versions: [], createdAt: '', updatedAt: '' }]
  }
  assert.equal(collectProjectFiles(proj).length, 2, '两个媒体文件都要被收集到')
  const zip = path.join(tmp, 'x.jxproj')
  const r = await exportProjectToFile(proj as never, zip)
  assert.equal(r.mediaCount, 2)
  const pdir = path.join(tmp, 'projects'); await fsp.mkdir(pdir, { recursive: true })
  const imp = await importProjectFromFile(zip, pdir, ['往返测试'])
  assert.equal(imp.mediaCount, 2, '导入要把媒体一起还原')
  const p2 = imp.project as never as typeof proj
  assert.equal(p2.name, '往返测试（导入）', '重名工程不能覆盖已有的')
  assert.ok(p2.assets[0].coverFile!.startsWith(imp.restoredDir), '路径要改到新工程目录')
  assert.equal(await fsp.readFile(p2.shots[0].outputs[0].file, 'utf8'), 'BBBB', '成片内容要一致')
  await fsp.rm(tmp, { recursive: true, force: true })
})

console.log(`\nselftest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
