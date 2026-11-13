/**
 * 纯 Node 的项目操作层（MCP 服务器用，不依赖 Electron）。
 * 直接读写 `<userData>/projects/<projectId>/project.json`。
 * 与 src/main/core/store.ts 的数据结构保持一致。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Asset, AssetKind, Episode, Project, Scene, Script, Shot } from '../shared/types.ts'

export const uid = (prefix = ''): string => prefix + crypto.randomBytes(6).toString('hex')
export const now = (): string => new Date().toISOString()

/** 解析项目根目录：优先环境变量 JXGF_PROJECTS，其次标准 userData 路径 */
export function resolveProjectsDir(): string {
  if (process.env.JXGF_PROJECTS) return process.env.JXGF_PROJECTS
  const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  // 兼容打包版 userData 命名：镜序工坊 / frameforge / FrameForge
  const candidates = [
    path.join(roaming, '镜序工坊', 'projects'),
    path.join(roaming, 'frameforge', 'projects'),
    path.join(roaming, 'FrameForge', 'projects')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[1] // 默认 frameforge
}

/** 读取 JSON 文本并容错 UTF-8 BOM（用户可能用记事本编辑过 project.json） */
function parseJsonLoose(raw: string): unknown {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(text)
}

const PROJECT_FILE = 'project.json'

export async function listProjects(projectsDir: string): Promise<
  { id: string; name: string; assetCount: number; shotCount: number; scriptCount: number; updatedAt: string }[]
> {
  await fsp.mkdir(projectsDir, { recursive: true })
  const out: {
    id: string
    name: string
    assetCount: number
    shotCount: number
    scriptCount: number
    updatedAt: string
  }[] = []
  for (const ent of await fsp.readdir(projectsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    try {
      const raw = await fsp.readFile(path.join(projectsDir, ent.name, PROJECT_FILE), 'utf8')
      const p = parseJsonLoose(raw) as Project
      out.push({
        id: p.id,
        name: p.name,
        assetCount: p.assets?.length ?? 0,
        shotCount: p.shots?.length ?? 0,
        scriptCount: p.scripts?.length ?? 0,
        updatedAt: p.updatedAt
      })
    } catch {
      // 跳过损坏项目
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function openProject(projectsDir: string, projectId: string): Promise<Project> {
  const file = path.join(projectsDir, projectId, PROJECT_FILE)
  const raw = await fsp.readFile(file, 'utf8')
  return parseJsonLoose(raw) as Project
}

export async function saveProject(projectsDir: string, project: Project): Promise<void> {
  const root = path.join(projectsDir, project.id)
  await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(path.join(root, 'media'), { recursive: true })
  project.updatedAt = now()
  const file = path.join(root, PROJECT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8')
  if (fs.existsSync(file)) await fsp.copyFile(file, `${file}.bak`).catch(() => undefined)
  await fsp.rename(tmp, file)
}

// ---------- 资产管理 ----------

export interface CreateAssetInput {
  kind: AssetKind
  name: string
  alias?: string
  tags?: string[]
  description?: string
  prompt?: string
  negative?: string
}

export function makeAsset(input: CreateAssetInput): Asset {
  return {
    id: uid('as_'),
    kind: input.kind,
    name: input.name,
    alias: input.alias,
    tags: input.tags ?? [],
    description: input.description ?? '',
    prompt: input.prompt ?? '',
    negative: input.negative ?? '',
    coverFile: null,
    images: [],
    versions: [],
    createdAt: now(),
    updatedAt: now()
  }
}

// ---------- 剧本结构 ----------

export function makeScript(name: string, index: number): Script {
  return { id: uid('scr_'), index, name, createdAt: now() }
}

export function makeEpisode(scriptId: string, title: string, index: number, summary = ''): Episode {
  return { id: uid('ep_'), scriptId, index, title, summary, status: 'writing' }
}

export function makeScene(
  episodeId: string,
  title: string,
  index: number,
  opts: { location?: string; time?: string; summary?: string } = {}
): Scene {
  return {
    id: uid('sc_'),
    episodeId,
    index,
    title,
    location: opts.location ?? '',
    time: opts.time ?? '',
    summary: opts.summary ?? ''
  }
}

export interface ShotInput {
  sceneId: string
  title: string
  index: number
  description?: string
  dialogue?: string
  camera?: string
  duration?: number
  characterIds?: string[]
  assetIds?: string[]
}

export function makeShot(input: ShotInput): Shot {
  return {
    id: uid('sh_'),
    sceneId: input.sceneId,
    index: input.index,
    title: input.title,
    description: input.description ?? '',
    dialogue: input.dialogue ?? '',
    camera: input.camera ?? '',
    duration: input.duration ?? 5,
    characterIds: input.characterIds ?? [],
    assetIds: input.assetIds ?? [],
    refImage: null,
    status: 'draft',
    outputs: [],
    createdAt: now(),
    updatedAt: now()
  }
}

/** 按 id 前缀找当前可用的 scriptId（未指定时取第一个） */
export function pickScriptId(project: Project, scriptId?: string): string {
  if (scriptId && project.scripts.some((s) => s.id === scriptId)) return scriptId
  if (project.scripts.length > 0) return project.scripts[0].id
  throw new Error('项目还没有剧本，请先 create_script')
}
