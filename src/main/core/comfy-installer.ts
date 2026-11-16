import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { resolveCatalog } from './catalog'
import { extractArchive } from './extract'
import type { DownloadManager } from './download'
import type { ComfyRuntime } from './comfy-runtime'
import type { GpuInfo, ComfyInstallState } from '@shared/types'

export type { ComfyInstallState }

function find7z(resourcesPath: string, appPath: string): string | null {
  const cands = [
    path.join(resourcesPath, 'tools', '7za.exe'),
    path.join(appPath, 'resources', 'tools', '7za.exe'),
    '7z.exe'
  ]
  for (const c of cands) {
    if (!c.includes(path.sep) && !c.includes('/')) return c
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // next
    }
  }
  return null
}

/** 在解压后的目录里找 ComfyUI 根（含 main.py 或 ComfyUI/main.py 的那层） */
function findComfyRoot(dir: string): string | null {
  const hasMain = (d: string): boolean =>
    fs.existsSync(path.join(d, 'main.py')) || fs.existsSync(path.join(d, 'ComfyUI', 'main.py'))
  if (hasMain(dir)) return dir
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const p = path.join(dir, e.name)
      if (hasMain(p)) return p
    }
  }
  return null
}

/**
 * 一键安装 ComfyUI（便携版）：下载 → 解压 → 配置运行时根目录 → 启动。
 * 通过 state 事件向渲染层汇报进度。模型不在此步（另行在环境检测里下载）。
 */
export class ComfyInstaller extends EventEmitter {
  private downloads: DownloadManager
  private runtime: ComfyRuntime
  private resourcesPath: string
  private appPath: string
  private runtimeDir: string

  constructor(deps: {
    downloads: DownloadManager
    runtime: ComfyRuntime
    resourcesPath: string
    appPath: string
    runtimeDir: string
  }) {
    super()
    this.downloads = deps.downloads
    this.runtime = deps.runtime
    this.resourcesPath = deps.resourcesPath
    this.appPath = deps.appPath
    this.runtimeDir = deps.runtimeDir
  }

  private emitState(s: ComfyInstallState): void {
    this.emit('state', s)
  }

  async install(gpu: GpuInfo): Promise<ComfyInstallState> {
    try {
      const items = resolveCatalog(this.runtimeDir, gpu)
      const rt = items.find((e) => e.kind === 'comfyui' && e.vendor === gpu.vendor) ?? items.find((e) => e.kind === 'comfyui')
      if (!rt) {
        const s: ComfyInstallState = { phase: 'error', percent: 0, message: '没有适用于本机显卡的 ComfyUI 安装包', error: 'no_runtime_for_gpu' }
        this.emitState(s)
        return s
      }

      await fsp.mkdir(this.runtimeDir, { recursive: true })

      // 1. 下载（若已存在则跳过）
      if (!fs.existsSync(rt.dest)) {
        this.emitState({ phase: 'downloading', percent: 0, message: `正在下载 ${rt.label}（约 ${Math.round((rt.sizeMB ?? 0) / 1024 * 10) / 10} GB）…` })
        const source = rt.sources[0]
        await this.downloadingWithProgress(rt.id, rt.label, source.url, rt.dest)
      } else {
        this.emitState({ phase: 'downloading', percent: 100, message: '安装包已存在，跳过下载' })
      }

      // 2. 解压
      if (!fs.existsSync(rt.extractedDir) || findComfyRoot(rt.extractedDir) === null) {
        this.emitState({ phase: 'extracting', percent: 0, message: '正在解压 ComfyUI（首次较久，请耐心）…' })
        const seven = find7z(this.resourcesPath, this.appPath) ?? undefined
        await extractArchive(rt.dest, rt.extractedDir, seven)
      } else {
        this.emitState({ phase: 'extracting', percent: 100, message: '已解压，跳过' })
      }

      // 3. 找根目录并写入运行时配置
      this.emitState({ phase: 'configuring', percent: 50, message: '正在配置运行时…' })
      const comfyRoot = findComfyRoot(rt.extractedDir) ?? rt.extractedDir
      const cfg = await this.runtime.getConfig()
      await this.runtime.setConfig({ ...cfg, root: comfyRoot, port: cfg.port || 8188, python: null })

      // 4. 启动
      this.emitState({ phase: 'starting', percent: 60, message: '正在启动 ComfyUI…' })
      const st = await this.runtime.start()
      if (st.status === 'error') {
        const s: ComfyInstallState = { phase: 'error', percent: 0, message: st.error ?? '启动失败', error: st.error }
        this.emitState(s)
        return s
      }
      const done: ComfyInstallState = {
        phase: 'done',
        percent: 100,
        message: st.status === 'running' ? 'ComfyUI 安装完成并已启动！下一步去「环境检测 → 模型库」下载模型。' : 'ComfyUI 已安装（启动未就绪，可稍后手动启动）'
      }
      this.emitState(done)
      return done
    } catch (err) {
      const s: ComfyInstallState = { phase: 'error', percent: 0, message: '安装失败', error: String((err as Error).message ?? err) }
      this.emitState(s)
      return s
    }
  }

  /** 走 DownloadManager 下载并轮询进度（DownloadManager 通过事件广播任务进度） */
  private downloadingWithProgress(id: string, label: string, url: string, dest: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const onState = (task: { id: string; status: string; percent: number; error?: string }): void => {
        if (task.id !== id) return
        if (task.status === 'downloading' || task.status === 'queued') {
          this.emitState({ phase: 'downloading', percent: task.percent, message: `正在下载 ${label}… ${task.percent}%` })
        } else if (task.status === 'done') {
          if (settled) return
          settled = true
          this.downloads.off('state', onState)
          resolve()
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          if (settled) return
          settled = true
          this.downloads.off('state', onState)
          reject(new Error(task.error ?? `下载${task.status}`))
        }
      }
      this.downloads.on('state', onState)
      try {
        this.downloads.start({ id, label, url, dest })
      } catch (err) {
        if (settled) return
        settled = true
        this.downloads.off('state', onState)
        reject(err)
      }
    })
  }
}
