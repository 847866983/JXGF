import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ComfyRuntimeConfig, ComfyRuntimeState } from '@shared/types'

const CONFIG_FILE = 'runtime.json'
const STATE_FILE = 'runtime-state.json'
const LOG_FILE = 'comfyui.log'

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  if (!pid) return false
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    return String(r.stdout ?? '').includes(String(pid))
  } catch {
    return false
  }
}

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 内置 ComfyUI 运行管理：探测安装、启动/停止进程、健康检查、日志尾巴。
 * 纯 Node（除进程操作），便于自检；主进程负责把 state 事件推给渲染层。
 */
export class ComfyRuntime extends EventEmitter {
  private readonly runtimeDir: string

  constructor(runtimeDir: string) {
    super()
    this.runtimeDir = runtimeDir
  }

  private cfgPath(): string {
    return path.join(this.runtimeDir, CONFIG_FILE)
  }
  private statePath(): string {
    return path.join(this.runtimeDir, STATE_FILE)
  }
  private logPath(): string {
    return path.join(this.runtimeDir, LOG_FILE)
  }

  async getConfig(): Promise<ComfyRuntimeConfig> {
    try {
      return JSON.parse(await fsp.readFile(this.cfgPath(), 'utf8')) as ComfyRuntimeConfig
    } catch {
      return { root: null, port: 8188, python: null }
    }
  }

  async setConfig(cfg: ComfyRuntimeConfig): Promise<ComfyRuntimeConfig> {
    await fsp.mkdir(this.runtimeDir, { recursive: true })
    await fsp.writeFile(this.cfgPath(), JSON.stringify(cfg, null, 2), 'utf8')
    return cfg
  }

  /** 探测 runtimeDir 下所有可用 ComfyUI 根目录 */
  detectRoots(): string[] {
    const roots: string[] = []
    // runtimeDir 本身可能就是 ComfyUI 根（含 main.py）
    if (exists(path.join(this.runtimeDir, 'ComfyUI', 'main.py')) || exists(path.join(this.runtimeDir, 'main.py'))) {
      roots.push(this.runtimeDir)
    }
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(this.runtimeDir, { withFileTypes: true })
    } catch {
      return roots
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(this.runtimeDir, e.name)
      if (exists(path.join(p, 'ComfyUI', 'main.py')) || exists(path.join(p, 'main.py'))) {
        roots.push(p)
      }
    }
    return roots
  }

  private findPython(root: string): string | null {
    const candidates = [
      path.join(root, 'python_embeded', 'python.exe'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'Scripts', 'python.exe')
    ]
    for (const c of candidates) if (exists(c)) return c
    return 'python' // 回退到 PATH
  }

  private mainPyOf(root: string): string | null {
    if (exists(path.join(root, 'ComfyUI', 'main.py'))) return path.join(root, 'ComfyUI', 'main.py')
    if (exists(path.join(root, 'main.py'))) return path.join(root, 'main.py')
    return null
  }

  private async readState(): Promise<{ pid: number; port: number; startedAt: string } | null> {
    try {
      return JSON.parse(await fsp.readFile(this.statePath(), 'utf8'))
    } catch {
      return null
    }
  }

  private logTail(n = 4000): string {
    try {
      const raw = fs.readFileSync(this.logPath(), 'utf8')
      return raw.slice(-n)
    } catch {
      return ''
    }
  }

  async status(): Promise<ComfyRuntimeState> {
    const cfg = await this.getConfig()
    const state = await this.readState()
    const roots = this.detectRoots()
    const root = cfg.root ?? roots[0] ?? null
    const port = Number(cfg.port) || 8188
    const alive = state ? isAlive(state.pid) : false
    const online = state ? await health(port) : false

    let status: ComfyRuntimeState['status']
    if (!root) status = 'missing'
    else if (alive || online) status = 'running'
    else if (state) status = 'stopped'
    else status = 'installed'

    return { status, root, port, pid: alive ? state?.pid ?? null : null, logTail: this.logTail() }
  }

  async start(): Promise<ComfyRuntimeState> {
    const cfg = await this.getConfig()
    const roots = this.detectRoots()
    const root = cfg.root ?? roots[0] ?? null
    if (!root) {
      return { status: 'missing', root: null, port: cfg.port, pid: null, logTail: '' }
    }
    const cur = await this.status()
    if (cur.status === 'running') return cur

    const python = cfg.python ?? this.findPython(root)
    const mainPy = this.mainPyOf(root)
    if (!python) {
      return { status: 'error', root, port: cfg.port, pid: null, logTail: this.logTail(), error: '未找到 python 解释器，请在根目录设置里指定' }
    }
    if (!mainPy) {
      return { status: 'error', root, port: cfg.port, pid: null, logTail: this.logTail(), error: `找不到 ComfyUI 入口：${path.join(root, 'ComfyUI', 'main.py')}` }
    }

    await fsp.mkdir(this.runtimeDir, { recursive: true })
    const logFd = fs.openSync(this.logPath(), 'a')
    const args = ['-s', mainPy, '--windows-standalone-build', '--listen', '127.0.0.1', '--port', String(cfg.port || 8188)]
    const child = spawn(python, args, {
      cwd: path.dirname(mainPy),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd] as ['ignore', number, number]
    })
    child.unref()
    fs.closeSync(logFd)
    await fsp.writeFile(this.statePath(), JSON.stringify({ pid: child.pid, port: cfg.port || 8188, startedAt: new Date().toISOString() }), 'utf8')

    // 轮询健康检查，最多 90 秒
    for (let i = 0; i < 45; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await health(Number(cfg.port) || 8188)) break
    }
    const st = await this.status()
    this.emit('state', st)
    return st
  }

  async stop(): Promise<ComfyRuntimeState> {
    const state = await this.readState()
    if (state?.pid && isAlive(state.pid)) {
      spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    }
    await fsp.rm(this.statePath(), { force: true }).catch(() => undefined)
    const st = await this.status()
    this.emit('state', st)
    return st
  }
}
