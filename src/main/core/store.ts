import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Project, ProjectSummary } from '@shared/types'

/** 容错 UTF-8 BOM 的 JSON 解析（用户可能用记事本编辑过 project.json） */
function parseJsonLoose(raw: string): unknown {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(text)
}

export const uid = (prefix = ''): string => prefix + crypto.randomBytes(6).toString('hex')
export const now = (): string => new Date().toISOString()

const PROJECT_FILE = 'project.json'
const SCHEMA = 1

export function emptyProject(name = '未命名项目'): Project {
  const script = { id: uid('scr_'), index: 1, name: '剧本一', createdAt: now() }
  return {
    schema: SCHEMA,
    id: uid('prj_'),
    name,
    createdAt: now(),
    updatedAt: now(),
    settings: {
      comfy: { host: '127.0.0.1', port: 8188, protocol: 'http' },
      aspect: '16:9',
      style: '',
      autoRetry: 1,
      retryDelaySec: 8,
      activeScriptId: script.id,
      presetId: 'auto'
    },
    scripts: [script],
    episodes: [],
    scenes: [],
    shots: [],
    assets: [],
    templates: [],
    aiChat: []
  }
}

function migrate(data: Project): Project {
  const base = emptyProject(data?.name || '未命名项目')
  const merged: Project = { ...base, ...data, schema: SCHEMA }
  for (const key of ['scripts', 'episodes', 'scenes', 'shots', 'assets', 'templates', 'aiChat'] as const) {
    if (!Array.isArray(merged[key])) merged[key] = []
  }
  merged.settings = { ...base.settings, ...(data?.settings || {}) }
  merged.settings.comfy = { ...base.settings.comfy, ...(data?.settings?.comfy || {}) }
  return merged
}

/**
 * 项目仓库：一个项目一个目录，project.json + media/ 子目录。
 * 不引入数据库，文件即真相，方便备份与迁移。
 */
export class ProjectStore {
  private current: Project | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly projectsDir: string
  /** 串行化 flush：多个调用方（jobs 回写 / 防抖保存 / 窗口关闭）可能并发，排队依次写盘 */
  private flushChain: Promise<void> = Promise.resolve()

  constructor(projectsDir: string) {
    this.projectsDir = projectsDir
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.projectsDir, { recursive: true })
  }

  private projectRoot(id: string): string {
    return path.join(this.projectsDir, id)
  }

  async list(): Promise<ProjectSummary[]> {
    await this.init()
    const out: ProjectSummary[] = []
    for (const entry of await fsp.readdir(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(this.projectsDir, entry.name, PROJECT_FILE)
      try {
        const raw = await fsp.readFile(file, 'utf8')
        const p = parseJsonLoose(raw) as Project
        out.push({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          assetCount: p.assets?.length ?? 0,
          shotCount: p.shots?.length ?? 0,
          scriptCount: p.scripts?.length ?? 0
        })
      } catch {
        // 损坏的项目目录跳过
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async create(name: string): Promise<Project> {
    await this.init()
    const p = emptyProject(name)
    this.current = p
    await this.flush()
    return p
  }

  async open(id: string): Promise<Project> {
    const file = path.join(this.projectsDir, id, PROJECT_FILE)
    const raw = await fsp.readFile(file, 'utf8')
    this.current = migrate(parseJsonLoose(raw) as Project)
    return this.current
  }

  getCurrent(): Project | null {
    return this.current
  }

  /** 渲染进程把整份项目数据回传保存（落盘后再返回，避免随后重读磁盘拿到旧数据） */
  async save(project: Project): Promise<Project> {
    project.updatedAt = now()
    this.current = migrate(project)
    await this.flush()
    return this.current
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.flush().catch((err) => console.error('[store] flush failed', err))
    }, 250)
  }

  async flush(): Promise<void> {
    // 串行排队：避免并发 flush 写同一个 tmp 文件导致覆盖/丢数据
    this.flushChain = this.flushChain.then(() => this.doFlush())
    return this.flushChain
  }

  private async doFlush(): Promise<void> {
    if (!this.current) return
    const root = this.projectRoot(this.current.id)
    await fsp.mkdir(root, { recursive: true })
    await fsp.mkdir(path.join(root, 'media'), { recursive: true })
    const file = path.join(root, PROJECT_FILE)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    const body = JSON.stringify(this.current, null, 2)
    await fsp.writeFile(tmp, body, 'utf8')
    if (fs.existsSync(file)) {
      await fsp.copyFile(file, `${file}.bak`).catch(() => undefined)
    }
    await fsp.rename(tmp, file)
  }

  mediaDir(): string {
    if (!this.current) throw new Error('没有打开的项目')
    return path.join(this.projectRoot(this.current.id), 'media')
  }

  /** 当前项目根目录（project.json 所在目录） */
  rootDir(): string {
    if (!this.current) throw new Error('没有打开的项目')
    return this.projectRoot(this.current.id)
  }

  /** 当前项目的记忆库目录（memory/） */
  memoryDir(): string {
    return path.join(this.rootDir(), 'memory')
  }
}
