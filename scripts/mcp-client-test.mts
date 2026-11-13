/**
 * 用官方 MCP Client 连本服务器，跑完整的「建剧本→集→场→分镜→资产」流程。
 * 运行：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/mcp-client-test.mts
 * 用临时项目目录（JXGF_PROJECTS），不污染真实数据。
 */
import assert from 'node:assert'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'jxgf-mcpc-'))

// 先用 project-api 造一个空项目
const { saveProject } = await import('../src/mcp/project-api.ts')
const pid = 'prj_' + Date.now()
await saveProject(tmp, {
  schema: 1,
  id: pid,
  name: 'MCP客户端测试',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  settings: { comfy: { host: '127.0.0.1', port: 8188, protocol: 'http' }, aspect: '16:9', style: '', autoRetry: 1, retryDelaySec: 8, activeScriptId: null, presetId: 'auto' },
  scripts: [], episodes: [], scenes: [], shots: [], assets: [], templates: []
} as never)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'src/mcp/server.ts'],
  env: { ...process.env, JXGF_PROJECTS: tmp }
})
const client = new Client({ name: 'mcpc', version: '1.0' }, { capabilities: {} })
await client.connect(transport)

let pass = 0
let fail = 0
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    fail += 1
    console.error(`FAIL  ${name}: ${String((err as Error).message ?? err)}`)
    process.exitCode = 1
  }
}

function textOf(r: unknown): string {
  const res = r as { content: { type: string; text: string }[] }
  return res.content[0].text
}

await step('tools/list 返回工具', async () => {
  const tools = await client.listTools()
  assert.ok(tools.tools.length >= 13, `工具数 ${tools.tools.length}`)
})

let scriptId = ''
let epId = ''
let scId = ''
await step('create_script', async () => {
  const r = await client.callTool({ name: 'create_script', arguments: { projectId: pid, name: 'AI演示剧本' } })
  scriptId = JSON.parse(textOf(r)).created.id
  assert.ok(scriptId.startsWith('scr_'))
})

await step('create_episode', async () => {
  const r = await client.callTool({ name: 'create_episode', arguments: { projectId: pid, title: '第一集', summary: '测试', scriptId } })
  epId = JSON.parse(textOf(r)).created.id
  assert.ok(epId.startsWith('ep_'))
})

await step('create_scene', async () => {
  const r = await client.callTool({ name: 'create_scene', arguments: { projectId: pid, episodeId: epId, title: '雨夜小巷', location: '旧城', time: '夜' } })
  scId = JSON.parse(textOf(r)).created.id
  assert.ok(scId.startsWith('sc_'))
})

await step('add_shots 批量建 2 个分镜', async () => {
  const r = await client.callTool({
    name: 'add_shots',
    arguments: { projectId: pid, sceneId: scId, shots: [{ title: '镜头A', description: '俯拍', duration: 5 }, { title: '镜头B', dialogue: '谁在那', camera: '中景', duration: 6 }] }
  })
  const data = JSON.parse(textOf(r))
  assert.equal(data.count, 2)
})

await step('create_asset', async () => {
  const r = await client.callTool({ name: 'create_asset', arguments: { projectId: pid, kind: 'character', name: 'AI角色', description: 'MCP建', prompt: 'a character' } })
  assert.ok(JSON.parse(textOf(r)).created.id.startsWith('as_'))
})

await step('list_shots 能读到刚建的 2 个分镜', async () => {
  const r = await client.callTool({ name: 'list_shots', arguments: { projectId: pid } })
  const shots = JSON.parse(textOf(r))
  assert.equal(shots.length, 2)
})

await step('落盘校验：磁盘 project.json 含这些数据', async () => {
  const raw = JSON.parse(await fsp.readFile(path.join(tmp, pid, 'project.json'), 'utf8'))
  assert.equal(raw.scripts.length, 1)
  assert.equal(raw.episodes.length, 1)
  assert.equal(raw.scenes.length, 1)
  assert.equal(raw.shots.length, 2)
  assert.equal(raw.assets.length, 1)
})

await client.close()
await fsp.rm(tmp, { recursive: true, force: true })

console.log(`\nmcp client test: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
