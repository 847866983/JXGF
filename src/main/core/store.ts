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
      activeEpisodeId: null,
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
 * 把后台写回的产物合并进"基于旧快照的待保存项目"：只补 incoming 里缺失的产物（按 file 去重），
 * 不删除用户改动的字段。仅在乐观锁检测到快照过期时调用。
 */
function mergeBackgroundOutputs(incoming: Project, current: Project): void {
  for (const curShot of current.shots ?? []) {
    const target = (incoming.shots ?? []).find((s) => s.id === curShot.id)
    if (!target) continue
    const have = new Set((target.outputs ?? []).map((o) => o.file))
    for (const o of curShot.outputs ?? []) {
      if (!have.has(o.file)) (target.outputs ??= []).push({ ...o })
    }
  }
  for (const curAsset of current.assets ?? []) {
    const target = (incoming.assets ?? []).find((a) => a.id === curAsset.id)
    if (!target) continue
    const have = new Set(target.images ?? [])
    for (const f of curAsset.images ?? []) if (!have.has(f)) (target.images ??= []).push(f)
    if (!target.coverFile && curAsset.coverFile) target.coverFile = curAsset.coverFile
  }
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
  /** 运行时乐观锁计数：任何对 current 的写入都递增，供渲染层保存时判断是否基于过期快照 */
  private rev = 0

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
    this.rev += 1
    p.rev = this.rev
    await this.flush()
    return p
  }

  async open(id: string): Promise<Project> {
    // 先把队列里待写的工程落盘再读——否则会读到旧数据，把 current（连同后台刚写回的产物）拉回过去
    await this.flush()
    const file = path.join(this.projectsDir, id, PROJECT_FILE)
    const raw = await fsp.readFile(file, 'utf8')
    this.current = migrate(parseJsonLoose(raw) as Project)
    // 新读入的快照给一个新的乐观锁版本：渲染层之后保存时才有新旧依据
    this.rev += 1
    this.current.rev = this.rev
    return this.current
  }

  getCurrent(): Project | null {
    return this.current
  }

  /** 给 IPC 用的快照：带上乐观锁 rev，渲染层保存时原样回传以校验是否过期 */
  snapshot(): Project | null {
    if (!this.current) return null
    return { ...structuredClone(this.current), rev: this.rev }
  }

  /**
   * 渲染进程把整份项目数据回传保存（落盘后再返回，避免随后重读磁盘拿到旧数据）。
   * 乐观锁：若 project.rev 缺失或落后于当前 rev，说明渲染层拿着的是旧快照
   * （openProject 返回的旧对象 / 页面滞留的 state），期间可能已有后台写入
   * （生成产物回写）——此时把 current 里的产物合并回来再保存，避免旧快照把
   * 刚生成的产物抹掉（表现为「生成完成但资产里不显示」）。
   * rev 一致则直接保存（用户主动删除版本的意图能正常生效）。
   */
  async save(project: Project): Promise<Project> {
    if (this.current && project.rev !== this.rev) {
      mergeBackgroundOutputs(project, this.current)
    }
    const nextRev = this.rev + 1
    project.updatedAt = now()
    const saved = migrate(project)
    saved.rev = nextRev
    this.current = saved
    this.rev = nextRev
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
    // Windows 上 project.json 可能被杀毒/索引/另一实例瞬时占用，rename 会抛 EPERM。
    // 这里重试；仍失败则回退为直接覆盖写，保证工程一定能落盘（否则删除等写操作会静默丢失）。
    let renamed = false
    for (let i = 0; i < 6; i++) {
      try {
        await fsp.rename(tmp, file)
        renamed = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    if (!renamed) {
      try {
        await fsp.writeFile(file, body, 'utf8')
        await fsp.rm(tmp, { force: true })
      } catch (err) {
        // 兜底也失败时留下 tmp（不误删），并明确抛出，让前端能提示用户
        throw new Error(`工程保存失败：${String((err as Error).message ?? err)}`)
      }
    }
  }

  mediaDir(): string {
    if (!this.current) throw new Error('没有打开的项目')
    return this.mediaDirFor(this.current.id)
  }

  /** 指定工程的 media 目录（不依赖 current，供后台任务归档到提交时的工程） */
  mediaDirFor(id: string): string {
    return path.join(this.projectRoot(id), 'media')
  }

  /**
   * 后台任务回写：把产物写进"提交任务时的工程"，即使此时用户已切到别的工程。
   * - 目标就是 current：直接改内存 current（前端 done 快照能拿到），再落盘。
   * - 目标不是 current：从磁盘读出来改完写回，绝不动 current，避免把用户正在看的工程切走。
   * 两条路径都复用 flushChain 串行化，避免与防抖保存/窗口关闭写盘互相覆盖。
   */
  async mutateProject(id: string, fn: (p: Project) => void): Promise<boolean> {
    if (this.current?.id === id) {
      fn(this.current)
      this.rev += 1
      await this.flush()
      return true
    }
    // 非当前工程：读盘 → 改 → 写盘（串行），不影响 current
    const file = path.join(this.projectRoot(id), PROJECT_FILE)
    let project: Project
    try {
      const raw = await fsp.readFile(file, 'utf8')
      project = migrate(parseJsonLoose(raw) as Project)
    } catch {
      return false
    }
    fn(project)
    project.updatedAt = now()
    this.flushChain = this.flushChain.then(async () => {
      const root = this.projectRoot(id)
      await fsp.mkdir(path.join(root, 'media'), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8')
      if (fs.existsSync(file)) await fsp.copyFile(file, `${file}.bak`).catch(() => undefined)
      await fsp.rename(tmp, file)
    })
    await this.flushChain
    return true
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
