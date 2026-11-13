import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
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
import { isUiWorkflow, convertUiToApi, detectWorkflowKind } from './core/workflow-convert'
import { Updater } from './core/updater'

let mainWindow: BrowserWindow | null = null
let hardware: HardwareReport | null = null
let hardwarePending: Promise<HardwareReport> | null = null
let store: ProjectStore
let jobs: JobManager
const downloads = new DownloadManager()
let comfyRuntime: ComfyRuntime
const updater = new Updater()

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
  ipcMain.handle(CH.appInfo, () => ({
    name: 'FrameForge Studio',
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    platform: process.platform
  }))

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
    return resolveCatalog(path.join(app.getPath('userData'), 'runtime'), report.gpu)
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

  ipcMain.handle(CH.projectList, () => store.list())
  ipcMain.handle(CH.projectCreate, async (_e, name: string) => store.create(name))
  ipcMain.handle(CH.projectOpen, (_e, id: string) => store.open(id))
  ipcMain.handle(CH.projectSave, (_e, project: Project) => store.save(project))

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

  ipcMain.handle(CH.jobGenerate, (_e, params: JobParams) => jobs.enqueue(params))
  ipcMain.handle(CH.jobList, () => jobs.list())
  ipcMain.handle(CH.jobCancel, (_e, jobId: string) => jobs.cancel(jobId))

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
  store = new ProjectStore(path.join(app.getPath('userData'), 'projects'))
  void store.init()

  comfyRuntime = new ComfyRuntime(path.join(app.getPath('userData'), 'runtime'))
  comfyRuntime.on('state', (state) => push({ type: 'comfy:runtime', state }))

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
