/**
 * MCP 服务器自检（不依赖 GUI）：验证工具注册、资产/分镜 CRUD 落盘。
 * 运行：pnpm test:mcp
 * 用临时项目目录，不影响真实数据。
 */
import assert from 'node:assert'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  resolveProjectsDir,
  listProjects,
  openProject,
  saveProject,
  makeAsset,
  makeScript,
  makeEpisode,
  makeScene,
  makeShot,
  pickScriptId
} from '../src/mcp/project-api.ts'

let pass = 0
let fail = 0
function ok(name: string, fn: () => void): void {
  try {
    fn()
    pass += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    fail += 1
    console.error(`FAIL  ${name}: ${String((err as Error).message ?? err)}`)
    process.exitCode = 1
  }
}

// 用临时目录做全流程
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jxgf-mcp-'))
const pid = 'prj_test_' + Date.now()

// 构造一个空项目
const project = {
  schema: 1,
  id: pid,
  name: 'MCP自检项目',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  settings: {
    comfy: { host: '127.0.0.1', port: 8188, protocol: 'http' as const },
    aspect: '16:9',
    style: '',
    autoRetry: 1,
    retryDelaySec: 8,
    activeScriptId: null as string | null,
    presetId: 'auto'
  },
  scripts: [] as ReturnType<typeof makeScript>[],
  episodes: [] as ReturnType<typeof makeEpisode>[],
  scenes: [] as ReturnType<typeof makeScene>[],
  shots: [] as ReturnType<typeof makeShot>[],
  assets: [] as ReturnType<typeof makeAsset>[],
  templates: [] as unknown[]
}
await saveProject(tmp, project)

ok('resolveProjectsDir 支持 JXGF_PROJECTS 环境变量', () => {
  const old = process.env.JXGF_PROJECTS
  process.env.JXGF_PROJECTS = 'D:\\fake\\projects'
  assert.equal(resolveProjectsDir(), 'D:\\fake\\projects')
  if (old === undefined) delete process.env.JXGF_PROJECTS
  else process.env.JXGF_PROJECTS = old
})

const listed = await listProjects(tmp)
ok('listProjects 能列出刚保存的项目', () => {
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, pid)
  assert.equal(listed[0].name, 'MCP自检项目')
})

// 资产 CRUD
await (async () => {
  const p = await openProject(tmp, pid)
  p.assets.push(makeAsset({ kind: 'character', name: '角色A', description: '中文描述', prompt: 'a char' }))
  p.assets.push(makeAsset({ kind: 'scene', name: '场景B' }))
  await saveProject(tmp, p)
})()
const pAfterAsset = await openProject(tmp, pid)
ok('create_asset：写入 2 个资产并落盘', () => {
  assert.equal(pAfterAsset.assets.length, 2)
  assert.equal(pAfterAsset.assets.filter((a) => a.kind === 'character').length, 1)
})
await (async () => {
  const p = await openProject(tmp, pid)
  const a = p.assets.find((x) => x.kind === 'character')!
  a.name = '角色A改名'
  a.tags = ['主角']
  await saveProject(tmp, p)
})()
const pAfterUpdate = await openProject(tmp, pid)
ok('update_asset：改名+标签已落盘', () => {
  const a = pAfterUpdate.assets.find((x) => x.kind === 'character')!
  assert.equal(a.name, '角色A改名')
  assert.deepEqual(a.tags, ['主角'])
})

// 剧本结构
await (async () => {
  const p = await openProject(tmp, pid)
  const s = makeScript('测试剧本', 1)
  p.scripts.push(s)
  p.settings.activeScriptId = s.id
  const sid = pickScriptId(p, undefined)
  const ep = makeEpisode(sid, '第一集', 1, '概要')
  p.episodes.push(ep)
  const sc = makeScene(ep.id, '雨巷', 1, { location: '旧城', time: '夜' })
  p.scenes.push(sc)
  p.shots.push(makeShot({ sceneId: sc.id, title: '镜头1', index: 1, description: '画面', duration: 6 }))
  p.shots.push(makeShot({ sceneId: sc.id, title: '镜头2', index: 2, dialogue: '台词' }))
  await saveProject(tmp, p)
})()
const pAfterStruct = await openProject(tmp, pid)
ok('剧本结构：script/episode/scene/shot 全部落盘', () => {
  assert.equal(pAfterStruct.scripts.length, 1)
  assert.equal(pAfterStruct.episodes.length, 1)
  assert.equal(pAfterStruct.scenes.length, 1)
  assert.equal(pAfterStruct.shots.length, 2)
})
ok('pickScriptId：未指定时取第一个剧本', () => {
  assert.equal(pickScriptId(pAfterStruct, undefined), pAfterStruct.scripts[0].id)
})
ok('pickScriptId：无剧本时报错', () => {
  assert.throws(() => pickScriptId({ ...pAfterStruct, scripts: [] } as never, undefined))
})

await fsp.rm(tmp, { recursive: true, force: true })

console.log(`\nmcp selftest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
