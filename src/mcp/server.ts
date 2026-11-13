#!/usr/bin/env node
/**
 * 镜序工坊 MCP 服务器（stdio 模式）。
 * 让 AI 助手（豆包 / DeepSeek Harness / Claude 等）直接操作本软件的
 * 剧本分镜与资产管理，工具见下方 TOOLS。
 *
 * 运行：node src/mcp/server.mjs   （或在 MCP 客户端里配置此命令）
 * 项目目录：优先环境变量 JXGF_PROJECTS，否则自动探测 %APPDATA%\{镜序工坊,frameforge,FrameForge}\projects
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
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
} from './project-api.ts'

const projectsDir = resolveProjectsDir()

const server = new McpServer({ name: 'jingxu-studio', version: '0.1.0' })

// 帮助函数：加载项目 -> 修改 -> 保存
async function withProject<T>(projectId: string, fn: (p: ReturnType<typeof openProject> extends Promise<infer R> ? R : never) => Promise<T> | T): Promise<T> {
  const project = await openProject(projectsDir, projectId)
  const result = await fn(project)
  await saveProject(projectsDir, project)
  return result
}

function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

// ---------- 项目 ----------

server.tool('list_projects', '列出所有项目（id、名称、资产/分镜数量）', {}, async () => {
  const list = await listProjects(projectsDir)
  return ok({ projectsDir, projects: list })
})

server.tool(
  'get_project_summary',
  '读取某个项目的完整结构概览（剧本/剧集/场次/分镜/资产统计）',
  { projectId: z.string().describe('项目 id') },
  async ({ projectId }) => {
    const p = await openProject(projectsDir, projectId)
    return ok({
      id: p.id,
      name: p.name,
      scripts: p.scripts,
      episodes: p.episodes.length,
      scenes: p.scenes.length,
      shots: p.shots.length,
      assets: { characters: p.assets.filter((a) => a.kind === 'character').length, scenes: p.assets.filter((a) => a.kind === 'scene').length, props: p.assets.filter((a) => a.kind === 'prop').length }
    })
  }
)

// ---------- 资产 ----------

server.tool(
  'list_assets',
  '列出项目的资产库（可按类型 character/scene/prop 过滤）',
  { projectId: z.string(), kind: z.enum(['character', 'scene', 'prop']).optional() },
  async ({ projectId, kind }) => {
    const p = await openProject(projectsDir, projectId)
    const assets = kind ? p.assets.filter((a) => a.kind === kind) : p.assets
    return ok(assets)
  }
)

server.tool(
  'create_asset',
  '新建资产（角色/场景/道具）',
  {
    projectId: z.string(),
    kind: z.enum(['character', 'scene', 'prop']),
    name: z.string(),
    alias: z.string().optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().optional().describe('中文描述'),
    prompt: z.string().optional().describe('英文绘图/生成提示词'),
    negative: z.string().optional()
  },
  async (args) => {
    const asset = await withProject(args.projectId, (p) => {
      const a = makeAsset({
        kind: args.kind,
        name: args.name,
        alias: args.alias,
        tags: args.tags,
        description: args.description,
        prompt: args.prompt,
        negative: args.negative
      })
      p.assets.push(a)
      return a
    })
    return ok({ created: asset })
  }
)

server.tool(
  'update_asset',
  '修改资产的字段（name/alias/tags/description/prompt/negative）',
  {
    projectId: z.string(),
    assetId: z.string(),
    patch: z
      .object({
        name: z.string().optional(),
        alias: z.string().optional(),
        tags: z.array(z.string()).optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        negative: z.string().optional()
      })
      .describe('要修改的字段')
  },
  async ({ projectId, assetId, patch }) => {
    const asset = await withProject(projectId, (p) => {
      const a = p.assets.find((x) => x.id === assetId)
      if (!a) throw new Error(`找不到资产 ${assetId}`)
      Object.assign(a, patch, { updatedAt: new Date().toISOString() })
      return a
    })
    return ok({ updated: asset })
  }
)

server.tool(
  'delete_asset',
  '删除一个资产',
  { projectId: z.string(), assetId: z.string() },
  async ({ projectId, assetId }) => {
    await withProject(projectId, (p) => {
      const i = p.assets.findIndex((x) => x.id === assetId)
      if (i < 0) throw new Error(`找不到资产 ${assetId}`)
      p.assets.splice(i, 1)
    })
    return ok(`已删除资产 ${assetId}`)
  }
)

// ---------- 剧本结构 ----------

server.tool(
  'create_script',
  '新建一个剧本（顶层容器）',
  { projectId: z.string(), name: z.string() },
  async ({ projectId, name }) => {
    const script = await withProject(projectId, (p) => {
      const s = makeScript(name, p.scripts.length + 1)
      p.scripts.push(s)
      p.settings.activeScriptId = s.id
      return s
    })
    return ok({ created: script })
  }
)

server.tool(
  'create_episode',
  '在剧本下新建一集',
  { projectId: z.string(), title: z.string(), summary: z.string().optional(), scriptId: z.string().optional() },
  async ({ projectId, title, summary, scriptId }) => {
    const ep = await withProject(projectId, (p) => {
      const sid = pickScriptId(p, scriptId)
      const idx = p.episodes.filter((e) => e.scriptId === sid).length + 1
      const e = makeEpisode(sid, title, idx, summary ?? '')
      p.episodes.push(e)
      return e
    })
    return ok({ created: ep })
  }
)

server.tool(
  'create_scene',
  '在场次下新建一场戏（需 episodeId）',
  {
    projectId: z.string(),
    episodeId: z.string(),
    title: z.string(),
    location: z.string().optional(),
    time: z.string().optional(),
    summary: z.string().optional()
  },
  async ({ projectId, episodeId, title, location, time, summary }) => {
    const sc = await withProject(projectId, (p) => {
      if (!p.episodes.some((e) => e.id === episodeId)) throw new Error(`找不到剧集 ${episodeId}`)
      const idx = p.scenes.filter((s) => s.episodeId === episodeId).length + 1
      const s = makeScene(episodeId, title, idx, { location, time, summary })
      p.scenes.push(s)
      return s
    })
    return ok({ created: sc })
  }
)

server.tool(
  'create_shot',
  '在场次下新建一个分镜（镜头）',
  {
    projectId: z.string(),
    sceneId: z.string(),
    title: z.string(),
    description: z.string().optional().describe('画面描述'),
    dialogue: z.string().optional(),
    camera: z.string().optional().describe('运镜'),
    duration: z.number().optional().describe('时长秒'),
    characterIds: z.array(z.string()).optional(),
    assetIds: z.array(z.string()).optional()
  },
  async ({ projectId, sceneId, title, description, dialogue, camera, duration, characterIds, assetIds }) => {
    const shot = await withProject(projectId, (p) => {
      if (!p.scenes.some((s) => s.id === sceneId)) throw new Error(`找不到场次 ${sceneId}`)
      const idx = p.shots.filter((s) => s.sceneId === sceneId).length + 1
      const sh = makeShot({ sceneId, title, index: idx, description, dialogue, camera, duration, characterIds, assetIds })
      p.shots.push(sh)
      return sh
    })
    return ok({ created: shot })
  }
)

server.tool(
  'add_shots',
  '批量在场次下新建多个分镜（一次提交整个分镜表，效率更高）',
  {
    projectId: z.string(),
    sceneId: z.string(),
    shots: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().optional(),
          dialogue: z.string().optional(),
          camera: z.string().optional(),
          duration: z.number().optional(),
          characterIds: z.array(z.string()).optional(),
          assetIds: z.array(z.string()).optional()
        })
      )
      .describe('分镜数组')
  },
  async ({ projectId, sceneId, shots }) => {
    const created = await withProject(projectId, (p) => {
      if (!p.scenes.some((s) => s.id === sceneId)) throw new Error(`找不到场次 ${sceneId}`)
      let idx = p.shots.filter((s) => s.sceneId === sceneId).length
      const out = []
      for (const s of shots) {
        idx += 1
        const sh = makeShot({ sceneId, title: s.title, index: idx, description: s.description, dialogue: s.dialogue, camera: s.camera, duration: s.duration, characterIds: s.characterIds, assetIds: s.assetIds })
        p.shots.push(sh)
        out.push({ id: sh.id, title: sh.title, index: sh.index })
      }
      return out
    })
    return ok({ created, count: created.length })
  }
)

server.tool(
  'list_shots',
  '列出分镜（可按场次过滤），返回标题/描述/台词/状态',
  { projectId: z.string(), sceneId: z.string().optional() },
  async ({ projectId, sceneId }) => {
    const p = await openProject(projectsDir, projectId)
    const shots = sceneId ? p.shots.filter((s) => s.sceneId === sceneId) : p.shots
    return ok(shots.map((s) => ({ id: s.id, sceneId: s.sceneId, index: s.index, title: s.title, description: s.description, dialogue: s.dialogue, camera: s.camera, duration: s.duration, status: s.status })))
  }
)

server.tool(
  'update_shot',
  '修改分镜字段（标题/描述/台词/运镜/时长/角色/资产）',
  {
    projectId: z.string(),
    shotId: z.string(),
    patch: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        dialogue: z.string().optional(),
        camera: z.string().optional(),
        duration: z.number().optional(),
        characterIds: z.array(z.string()).optional(),
        assetIds: z.array(z.string()).optional()
      })
  },
  async ({ projectId, shotId, patch }) => {
    const shot = await withProject(projectId, (p) => {
      const s = p.shots.find((x) => x.id === shotId)
      if (!s) throw new Error(`找不到分镜 ${shotId}`)
      Object.assign(s, patch, { updatedAt: new Date().toISOString() })
      return s
    })
    return ok({ updated: shot })
  }
)

// ---------- 启动 ----------

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 注意：stdio 模式下 stdout 属于协议通道，日志必须走 stderr
  console.error(`[jingxu-mcp] ready. projectsDir=${projectsDir}`)
}

main().catch((err) => {
  console.error('[jingxu-mcp] fatal:', err)
  process.exit(1)
})
