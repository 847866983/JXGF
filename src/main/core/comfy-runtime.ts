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
  detectRoots(): string[] {    const roots: string[] = []
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
      // venv 优先：整合包常把完整依赖（torch 等）装在 venv，而 python_embeded/python 可能是精简解释器
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(root, 'python_embeded', 'python.exe'),
      path.join(root, 'python', 'python.exe'),
      path.join(root, 'ComfyUI', 'python_embeded', 'python.exe')
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
    const logPath = this.logPath()
    const port = cfg.port || 8188
    // Windows 下 python.exe 是控制台程序，直接 spawn 会弹出黑色控制台窗口，
    // windowsHide 对 detached 子进程无效。改由 PowerShell 的 Start-Process -WindowStyle Hidden
    // 启动，可彻底隐藏窗口；同时用 -PassThru 回读真实 pid 写入状态文件。
    const env_prefix =
      '$env:PYTHONIOENCODING="utf-8";$env:PYTHONUTF8="1";$env:PYTHONLEGACYWINDOWSSTDIO="0";'
    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `${env_prefix}$p=Start-Process -FilePath '${python.replace(/'/g, "''")}' ` +
        `-ArgumentList @('-s','${mainPy.replace(/'/g, "''")}','--windows-standalone-build','--listen','127.0.0.1','--port','${port}') ` +
        `-WorkingDirectory '${path.dirname(mainPy).replace(/'/g, "''")}' -WindowStyle Hidden -PassThru ` +
        `-RedirectStandardOutput '${logPath.replace(/'/g, "''")}' -RedirectStandardError '${logPath.replace(/'/g, "''")}.err'; ` +
        `$p.Id`
    ]
    const ps = spawn('powershell.exe', psArgs, { windowsHide: true })
    let pidText = ''
    ps.stdout?.on('data', (d: Buffer) => (pidText += d.toString()))
    const psExit = new Promise<void>((resolve) => ps.on('exit', () => resolve()))
    // 等 PowerShell 打印 pid（最多 8 秒）
    await Promise.race([psExit, new Promise((r) => setTimeout(r, 8000))])
    const startedPid = Number(pidText.trim().split(/\s+/).pop()) || ps.pid || 0
    await fsp.writeFile(this.statePath(), JSON.stringify({ pid: startedPid, port, startedAt: new Date().toISOString() }), 'utf8')

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

  /**
   * 自动检测本机是否装有 ComfyUI：扫描常见盘符下的候选目录，找到含 main.py 或 ComfyUI\main.py 的根。
   * 找到则写入配置（若尚未配置），返回该根目录；否则返回 null。
   */
  async autoDetect(): Promise<string | null> {
    const cfg = await this.getConfig()
    if (cfg.root && exists(cfg.root)) return cfg.root // 已配置且有效，直接用
    // runtimeDir 内先找（一键安装的）
    const inRuntime = this.detectRoots()
    if (inRuntime.length > 0) {
      await this.setConfig({ ...cfg, root: inRuntime[0] })
      return inRuntime[0]
    }
    // 扫常见位置 + 每个盘符一层子目录（覆盖 D:\ManjuStudio\comfyui、D:\AI\xxx 等自定义路径）
    const candidates: string[] = []
    const drives = ['C', 'D', 'E', 'F', 'G']
    const names = ['ComfyUI', 'ComfyUI_windows_portable', 'comfyui', 'ComfyUI-Installs']
    for (const d of drives) {
      for (const n of names) {
        candidates.push(`${d}:\\${n}`)
        candidates.push(`${d}:\\${n}\\ComfyUI`)
      }
      candidates.push(`${d}:\\AI\\ComfyUI`, `${d}:\\Program Files\\ComfyUI`)
      // 一层子目录扫描：找 <盘>:\<任意目录>\ComfyUI\main.py 或 <盘>:\<任意目录>\main.py
      try {
        for (const e of fs.readdirSync(`${d}:\\`, { withFileTypes: true })) {
          if (!e.isDirectory()) continue
          candidates.push(`${d}:\\${e.name}\\ComfyUI`, `${d}:\\${e.name}`)
        }
      } catch {
        // 盘符不存在或不可读，跳过
      }
    }
    for (const c of [...new Set(candidates)]) {
      if (exists(path.join(c, 'main.py'))) {
        // 找到 ComfyUI 本体目录；根 = 其父（含 venv/python_embeded）
        const root = exists(path.join(c, '..', 'python_embeded')) || exists(path.join(c, '..', 'venv')) ? path.dirname(c) : c
        await this.setConfig({ ...cfg, root })
        return root
      }
      if (exists(path.join(c, 'ComfyUI', 'main.py'))) {
        await this.setConfig({ ...cfg, root: c })
        return c
      }
    }
    return null
  }
}
