import { app, BrowserWindow, ipcMain, shell, protocol } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { CH, type PushEvent } from '../shared/ipc'
import type {
  ComfyRuntimeConfig,
  DownloadRequest,
  EnvironmentReport,
  FfmpegInfo,
  HardwareReport,
  JobParams,
  ModelInventory,
  Project,
  UpdateInfo
} from '../shared/types'
import { detectGpu } from './core/hardware'
import { buildHardwareReport } from './core/presets'
import { makeClient } from './core/comfy'
import { ProjectStore, uid, now } from './core/store'
import { JobManager } from './core/jobs'
import { DownloadManager } from './core/download'
import { resolveCatalog } from './core/catalog'
import { extractArchive } from './core/extract'
import { ComfyRuntime } from './core/comfy-runtime'
import { ComfyInstaller } from './core/comfy-installer'
import { isUiWorkflow, convertUiToApi, detectWorkflowKind } from './core/workflow-convert'
import { listMemory, readMemory, writeMemory, appendMemory } from './core/memory'
import { AiAssistant } from './core/ai-assistant'
import { defaultAiConfig, normalizeAiConfig, type AiConfig } from '../shared/ai'
import { Updater } from './core/updater'

let mainWindow: BrowserWindow | null = null
let hardware: HardwareReport | null = null
let hardwarePending: Promise<HardwareReport> | null = null
let store: ProjectStore
let jobs: JobManager
const downloads = new DownloadManager()
let comfyRuntime: ComfyRuntime
let comfyInstaller: ComfyInstaller
const updater = new Updater()
let aiAssistant: AiAssistant
let skillsRoot = ''
let aiConfigFile = ''

// 必须在 app ready 前注册自定义协议特权
protocol.registerSchemesAsPrivileged([
  { scheme: 'appmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function push(payload: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CH.event, payload)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0b10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function getHardware(): Promise<HardwareReport> {
  if (hardware) return Promise.resolve(hardware)
  if (hardwarePending) return hardwarePending
  hardwarePending = detectGpu().then((gpu) => {
    hardware = buildHardwareReport(gpu)
    return hardware
  })
  return hardwarePending
}

function detectFfmpeg(): FfmpegInfo {
  // 1) 优先 PATH 里的 ffmpeg；2) 其次应用随包目录（后续打包时提供 runtime/ffmpeg）
  const candidates = [
    'ffmpeg',
    path.join(process.resourcesPath, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    path.join(process.cwd(), 'runtime', 'ffmpeg', 'ffmpeg.exe')
  ]
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      const first = String(r.stdout ?? '').split(/\r?\n/)[0] ?? ''
      const m = first.match(/ffmpeg version\s+(\S+)/i)
      if (r.status === 0 || m) {
        return { found: true, path: bin, version: m?.[1] ?? first.slice(0, 40) }
      }
    } catch {
      // continue
    }
  }
  return { found: false, path: null }
}

function registerIpc(): void {
  ipcMain.handle(CH.appInfo, () => {
    const userData = app.getPath('userData')
    const projectsDir = path.join(userData, 'projects')
    // MCP server 脚本路径：打包后位于 resources/mcp/server.mjs，开发时在 src/mcp/server.ts
    const mcpScript = app.isPackaged
      ? path.join(process.resourcesPath, 'mcp', 'server.mjs')
      : path.join(app.getAppPath(), 'src', 'mcp', 'server.ts')

    // 打包版：用软件自带的 Electron 作为 Node 运行时（用户无需安装 Node）。
    //   command = 本软件 exe；env.ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式运行；
    //   args = MCP server 脚本。路径均由运行时推导，换电脑自动适配。
    // 开发版：直接调系统 node 跑 .ts。
    const mcp =
      app.isPackaged
        ? {
            command: process.execPath,
            args: [mcpScript],
            env: { ELECTRON_RUN_AS_NODE: '1', JXGF_PROJECTS: projectsDir, JXGF_SKILLS: path.join(process.resourcesPath, 'skills') },
            script: mcpScript,
            projectsDir,
            note: '无需安装 Node：使用软件自带的运行时'
          }
        : {
            command: 'node',
            args: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', mcpScript],
            env: { JXGF_PROJECTS: projectsDir, JXGF_SKILLS: path.join(app.getAppPath(), 'skills') },
            script: mcpScript,
            projectsDir,
            note: '开发模式：使用系统 Node 运行 TypeScript 源码'
          }

    return {
      name: '镜序工坊',
      version: app.getVersion(),
      packaged: app.isPackaged,
      userData,
      platform: process.platform,
      mcp
    }
  })

  ipcMain.handle(CH.hardwareDetect, () => getHardware())

  ipcMain.handle(CH.comfyStatus, async (_e, settings) => {
    const project = store.getCurrent()
    const s = settings ?? project?.settings.comfy ?? { host: '127.0.0.1', port: 8188, protocol: 'http' }
    const client = makeClient(s)
    const stats = await client.systemStats()
    if (stats.online) {
      const q = await client.queueStatus()
      stats.queueRemaining = q.queueRemaining
      stats.queueRunning = q.queueRunning
    }
    return stats
  })

  ipcMain.handle(CH.comfyTest, async (_e, settings) => {
    const project = store.getCurrent()
    const s = settings ?? project?.settings.comfy ?? { host: '127.0.0.1', port: 8188, protocol: 'http' }
    const stats = await makeClient(s).systemStats()
    return { ok: stats.online, version: stats.version, error: stats.online ? null : '无法连接 ComfyUI，请确认已启动且地址正确' }
  })

  ipcMain.handle(CH.envScan, async (): Promise<EnvironmentReport> => {
    const gpu = await getHardware()
    const project = store.getCurrent()
    const s = project?.settings.comfy ?? { host: '127.0.0.1', port: 8188, protocol: 'http' }
    const client = makeClient(s)
    const comfy = await client.systemStats()
    let models: ModelInventory = { checkpoints: [], loras: [], vaes: [] }
    if (comfy.online) {
      try {
        models = await client.modelInventory()
      } catch {
        // 自定义节点环境可能没有标准加载器，保持空清单
      }
    }
    return { gpu, comfy, models, ffmpeg: detectFfmpeg(), scannedAt: now() }
  })

  ipcMain.handle(CH.envCatalog, async () => {
    const report = await getHardware()
    // 若已配置 ComfyUI 根目录，模型直接下到它的 models/，这样 ComfyUI 能直接加载。
    // 根目录可能是「含 ComfyUI 子目录的上级」或「ComfyUI 目录本身」，按实际结构判断。
    const st = await comfyRuntime.status()
    let modelsRoot: string | null = null
    if (st.root) {
      modelsRoot = fs.existsSync(path.join(st.root, 'ComfyUI', 'models'))
        ? path.join(st.root, 'ComfyUI', 'models')
        : path.join(st.root, 'models')
    }
    return resolveCatalog(path.join(app.getPath('userData'), 'runtime'), report.gpu, modelsRoot)
  })

  ipcMain.handle(CH.envExtract, async (_e, payload: { archive: string; dest: string }) => {
    const installRoot = path.join(app.getPath('userData'), 'runtime')
    const archive = path.resolve(payload.archive)
    const dest = path.resolve(payload.dest)
    if (!dest.startsWith(installRoot + path.sep)) {
      throw new Error('解压目标必须在应用运行时目录内')
    }
    return extractArchive(archive, dest)
  })

  ipcMain.handle(CH.comfyRuntimeStatus, () => comfyRuntime.status())
  ipcMain.handle(CH.comfyRuntimeStart, () => comfyRuntime.start())
  ipcMain.handle(CH.comfyRuntimeStop, () => comfyRuntime.stop())
  ipcMain.handle(CH.comfyRuntimeSetConfig, (_e, cfg: ComfyRuntimeConfig) => comfyRuntime.setConfig(cfg))
  ipcMain.handle(CH.comfyInstallStart, async () => {
    const hw = await getHardware()
    return comfyInstaller.install(hw.gpu)
  })

  ipcMain.handle(CH.projectList, () => store.list())
  ipcMain.handle(CH.projectCreate, async (_e, name: string) => store.create(name))
  ipcMain.handle(CH.projectOpen, (_e, id: string) => store.open(id))
  ipcMain.handle(CH.projectSave, (_e, project: Project) => store.save(project))
  // 返回主进程当前项目的深拷贝：渲染层 persistProject 用它做 base，
  // 避免用旧快照覆盖主进程 side-effect 写入（如生成完成后写回的 shot.outputs）
  ipcMain.handle(CH.projectGetCurrent, () => {
    const cur = store.getCurrent()
    return cur ? (structuredClone(cur) as Project) : null
  })

  ipcMain.handle(CH.projectImportTemplate, async (_e, payload: { name: string; kind?: 'image' | 'video'; apiJson: unknown }) => {
    const project = store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    let apiJson = payload.apiJson

    // 如果是 UI 格式（含 nodes/links），自动转 API 格式
    if (isUiWorkflow(payload.apiJson)) {
      apiJson = await convertUiToApi(payload.apiJson, project.settings.comfy)
    }

    const kind = payload.kind ?? detectWorkflowKind(apiJson as Record<string, { class_type: string }>)

    const template = {
      id: uid('tpl_'),
      name: payload.name,
      kind,
      apiJson,
      mapping: { version: 1 },
      createdAt: now()
    }
    project.templates.push(template)
    await store.flush()
    return template
  })

  // ---- 记忆库 ----
  ipcMain.handle(CH.memoryList, () => {
    if (!store.getCurrent()) throw new Error('请先打开一个项目')
    return listMemory(store.memoryDir())
  })
  ipcMain.handle(CH.memoryRead, (_e, key: string) => {
    if (!store.getCurrent()) throw new Error('请先打开一个项目')
    return readMemory(store.memoryDir(), key)
  })
  ipcMain.handle(CH.memoryWrite, (_e, key: string, content: string) => {
    if (!store.getCurrent()) throw new Error('请先打开一个项目')
    return writeMemory(store.memoryDir(), key, content)
  })
  ipcMain.handle(CH.memoryAppend, (_e, key: string, text: string) => {
    if (!store.getCurrent()) throw new Error('请先打开一个项目')
    return appendMemory(store.memoryDir(), key, text)
  })

  // ---- AI 助手 ----
  const loadAiConfig = (): AiConfig => {
    try {
      return normalizeAiConfig(JSON.parse(fs.readFileSync(aiConfigFile, 'utf8')))
    } catch {
      return defaultAiConfig()
    }
  }
  ipcMain.handle(CH.aiGetConfig, () => loadAiConfig())
  ipcMain.handle(CH.aiSetConfig, (_e, cfg: AiConfig) => {
    const normalized = normalizeAiConfig(cfg)
    try {
      fs.writeFileSync(aiConfigFile, JSON.stringify(normalized, null, 2), 'utf8')
    } catch {
      // ignore
    }
    return normalized
  })
  ipcMain.handle(CH.aiListModels, async (_e, providerId?: string) => {
    const cfg = loadAiConfig()
    const provider = providerId
      ? cfg.providers.find((p) => p.id === providerId)
      : cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0]
    if (!provider) return { ok: false, models: [], message: '没有可用的接口配置' }
    return aiAssistant.listModels(provider)
  })

  ipcMain.handle(CH.aiTest, async (_e, providerId?: string) => {
    const cfg = loadAiConfig()
    const provider = providerId
      ? cfg.providers.find((p) => p.id === providerId)
      : cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0]
    if (!provider) return { ok: false, message: '没有可测试的接口配置' }
    return aiAssistant.testProvider(provider)
  })

  ipcMain.handle(CH.aiChat, async (_e, payload: { messages: { role: 'user' | 'assistant'; content: string }[] }) => {
    const cfg = loadAiConfig()
    const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0]
    try {
      const res = await aiAssistant.chat(provider, payload.messages ?? [], (e) => {
        if (e.type === 'status') push({ type: 'ai:status', text: String(e.text ?? '') })
        else if (e.type === 'tool')
          push({
            type: 'ai:tool',
            name: String(e.name),
            args: (e.args as Record<string, unknown>) ?? {},
            summary: e.summary ? String(e.summary) : undefined
          })
      })
      if (res.changed) await store.flush()
      push({ type: 'ai:done', changed: res.changed })
      return res
    } catch (err) {
      push({ type: 'ai:error', message: String((err as Error).message ?? err) })
      throw err
    }
  })

  // 本地图片/视频读取成 data URL（供渲染进程预览，避开 file:// 安全限制）。
  // 视频走 base64 会放大 1.33 倍，限制 200MB 防止内存爆炸（更大文件请走 appmedia:// 流式）。
  ipcMain.handle(CH.mediaDataUrl, async (_e, p: string) => {
    try {
      const stat = await fsp.stat(p)
      if (stat.size > 200 * 1024 * 1024) return null
      const buf = await fsp.readFile(p)
      const ext = path.extname(p).toLowerCase()
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.mp4'
                  ? 'video/mp4'
                  : ext === '.webm'
                    ? 'video/webm'
                    : 'application/octet-stream'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // 删除媒体文件（物理删除），删除前检查是否仍被当前项目引用，避免误删其它资产/分镜还在用的文件
  ipcMain.handle(CH.mediaDeleteFile, async (_e, p: string) => {
    try {
      const project = store.getCurrent()
      if (!project) return { deleted: false, reason: '没有打开的项目' }
      const norm = path.resolve(p)
      const isReferenced = (file: string | null | undefined): boolean => {
        if (!file) return false
        try {
          return path.resolve(file) === norm
        } catch {
          return false
        }
      }
      const referenced =
        project.assets.some((a) => a.coverFile === norm || a.images.some((i) => i === norm)) ||
        project.shots.some((s) => s.outputs.some((o) => o.file === norm) || isReferenced(s.refImage))
      if (referenced) return { deleted: false, reason: '该文件仍被其它资产或分镜引用' }
      await fsp.rm(norm, { force: true })
      return { deleted: true }
    } catch (err) {
      return { deleted: false, reason: String((err as Error).message ?? err) }
    }
  })

  ipcMain.handle(CH.jobGenerate, (_e, params: JobParams) => jobs.enqueue(params))
  ipcMain.handle(CH.jobList, () => jobs.list())
  ipcMain.handle(CH.jobCancel, (_e, jobId: string) => jobs.cancel(jobId))
  ipcMain.handle(CH.jobRetry, (_e, jobId: string) => jobs.retry(jobId))

  ipcMain.handle(CH.updateInfo, () => updater.getInfo())
  ipcMain.handle(CH.updateCheck, () => updater.check())
  ipcMain.handle(CH.updateDownload, () => updater.download())
  ipcMain.handle(CH.updateInstall, () => updater.quitAndInstall())

  ipcMain.handle(CH.downloadStart, (_e, req: DownloadRequest) => downloads.start(req))
  ipcMain.handle(CH.downloadList, () => downloads.list())
  ipcMain.handle(CH.downloadCancel, (_e, id: string) => downloads.cancel(id))

  ipcMain.handle(CH.shellOpenPath, (_e, p: string) => shell.openPath(p))
}

app.whenReady().then(() => {
  // 自定义协议：本地图片/视频预览（避开 file:// 的 web 安全限制，支持中文路径）
  // 用法：appmedia:///C:/path/to/file.png  → 读取该绝对路径文件
  protocol.handle('appmedia', async (request) => {
    try {
      const u = new URL(request.url)
      let p = decodeURIComponent(u.pathname)
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1) // /C:/foo -> C:/foo
      const buf = await fsp.readFile(p)
      const ext = path.extname(p).toLowerCase()
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.mp4'
                  ? 'video/mp4'
                  : ext === '.webm'
                    ? 'video/webm'
                    : 'application/octet-stream'
      return new Response(new Uint8Array(buf), { headers: { 'content-type': mime, 'cache-control': 'no-cache' } })
    } catch (err) {
      return new Response(`not found: ${String((err as Error).message ?? err)}`, { status: 404 })
    }
  })

  store = new ProjectStore(path.join(app.getPath('userData'), 'projects'))
  void store.init()

  comfyRuntime = new ComfyRuntime(path.join(app.getPath('userData'), 'runtime'))
  comfyRuntime.on('state', (state) => push({ type: 'comfy:runtime', state }))

  comfyInstaller = new ComfyInstaller({
    downloads,
    runtime: comfyRuntime,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    runtimeDir: path.join(app.getPath('userData'), 'runtime')
  })
  comfyInstaller.on('state', (state) => push({ type: 'comfy:install', state }))

  // AI 助手：内置技能目录 + 全局 AI 配置
  skillsRoot = app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(app.getAppPath(), 'skills')
  aiConfigFile = path.join(app.getPath('userData'), 'ai-config.json')
  aiAssistant = new AiAssistant(store, skillsRoot)

  jobs = new JobManager(store, (type, payload) => {
    push({ type, ...(payload as Record<string, unknown>) } as PushEvent)
  })

  updater.setEmitter((payload) => push(payload))

  downloads.on('state', (task) => push({ type: 'download:state', task }))

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 启动后静默检查一次更新（仅打包版本有效）
  setTimeout(() => void updater.check(), 5000)

  // 启动后自动检测本机是否已装 ComfyUI，找到则接管；若已装未运行则自动启动
  setTimeout(() => {
    void (async () => {
      try {
        const found = await comfyRuntime.autoDetect()
        if (!found) return
        const st = await comfyRuntime.status()
        push({ type: 'comfy:runtime', state: st })
        // 已安装但未运行 → 自动启动（后台，不阻塞）
        if (st.status === 'installed' || st.status === 'stopped') {
          void comfyRuntime.start().catch(() => undefined)
        }
      } catch {
        // 忽略
      }
    })()
  }, 1500)
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  void store?.flush()
  app.quit()
})

app.on('before-quit', () => {
  void store?.flush()
})

export type { UpdateInfo }
