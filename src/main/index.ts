import { app, BrowserWindow, ipcMain, shell, protocol , dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { CH, type PushEvent } from '../shared/ipc'
import type {
  ComfyRuntimeConfig,
  DownloadRequest,
  FfmpegInfo,
  HardwareReport,
  JobParams,
  Project,
  UpdateInfo
} from '../shared/types'
import { detectGpu } from './core/hardware'
import { buildHardwareReport } from './core/presets'
import { makeClient } from './core/comfy'
import { ProjectStore, uid, now } from './core/store'
import { JobManager } from './core/jobs'
import { ComfyRuntime } from './core/comfy-runtime'
import { isUiWorkflow, convertUiToApi, detectWorkflowKind } from './core/workflow-convert'
import { adaptTemplateForGpu, degradeMissingLoras, resetVramFieldsToAuthor } from './core/template-adapt'
import { buildBuiltinTemplates } from './core/builtin-workflows'
import { listComfyWorkflows, readComfyWorkflow, normalizeKey } from './core/workflow-sync'
import { exportProjectToFile, importProjectFromFile } from './core/project-archive'
import { listMemory, readMemory, writeMemory, appendMemory } from './core/memory'
import { AiAssistant } from './core/ai-assistant'
import { defaultAiConfig, normalizeAiConfig, type AiConfig } from '../shared/ai'
import { Updater } from './core/updater'

let mainWindow: BrowserWindow | null = null
let hardware: HardwareReport | null = null
let hardwarePending: Promise<HardwareReport> | null = null
let store: ProjectStore
let jobs: JobManager
let comfyRuntime: ComfyRuntime
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
    // 并行拉取，避免两次 4s 超时串行叠加拖慢状态刷新
    const [stats, q] = await Promise.all([
      client.systemStats(),
      client.queueStatus()
    ])
    if (stats.online) {
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


  // ---- ComfyUI 连接与运行时（只保留连接相关，不提供下载/安装）----
  ipcMain.handle(CH.comfyRuntimeStatus, () => comfyRuntime.status())
  ipcMain.handle(CH.comfyRuntimeStart, () => comfyRuntime.start())
  ipcMain.handle(CH.comfyRuntimeStop, () => comfyRuntime.stop())
  ipcMain.handle(CH.comfyRuntimeSetConfig, (_e, cfg: ComfyRuntimeConfig) => comfyRuntime.setConfig(cfg))


  ipcMain.handle(CH.projectList, () => store.list())
  /** 把内置图片/视频工作流补进项目模板（按 name 去重，缺则补）。跟随软件走，无需手动导入。 */
  async function seedBuiltinTemplates(project: Project): Promise<void> {
    try {
      const added = buildBuiltinTemplates(project.templates, uid, now)
      if (added.length === 0) return
      // 按本机显存适配后加入
      const hw = await getHardware()
      for (const tpl of added) tpl.apiJson = adaptTemplateForGpu(tpl.apiJson, hw.gpu)
      project.templates.push(...added)
      await store.flush()
    } catch {
      // 内置工作流加载失败不阻断项目打开
    }
  }

  ipcMain.handle(CH.projectCreate, async (_e, name: string) => {
    const project = await store.create(name)
    await seedBuiltinTemplates(project)
    return project
  })
  ipcMain.handle(CH.projectOpen, async (_e, id: string) => {
    const project = await store.open(id)
    // 老项目/空项目没有模板时补内置工作流（否则生成时会报「没有工作流」）
    await seedBuiltinTemplates(project)
    // 打开工程时清一次孤儿媒体文件（没被任何资产/分镜引用的旧图）
    void cleanupOrphansNow()
    // 打开旧项目时按本机显存适配模板（修 12GB 放大模型在 6GB 卡上的 OOM）。
    // 注意：先重置成作者原配再适配 —— 老项目里存的模板可能被旧版降级逻辑写坏
    // （放大倍数锁成 1、显存预设硬编码 6GB），单纯再适配一次无法恢复。
    try {
      const hw = await getHardware()
      // 内置模板（作者原配）作为参考，用于恢复被旧版降级写坏的放大倍数。
      // 注意：buildBuiltinTemplates 会重新生成 id，所以按 name 匹配。
      const builtins = buildBuiltinTemplates([], uid, now)
      const authorByName = new Map<string, unknown>()
      for (const b of builtins) authorByName.set(b.name, b.apiJson)
      let changed = false
      for (const tpl of project.templates) {
        const author = authorByName.get(tpl.name)
        const reset = resetVramFieldsToAuthor(tpl.apiJson, author)
        if (reset !== tpl.apiJson) {
          tpl.apiJson = reset
          changed = true
        }
        const adapted = adaptTemplateForGpu(tpl.apiJson, hw.gpu)
        if (adapted !== tpl.apiJson) {
          tpl.apiJson = adapted
          changed = true
        }
      }
      if (changed) await store.flush()
    } catch {
      // 适配失败不阻断打开
    }
    // 缺失 LoRA 自动降级（私有/社区 LoRA 无公开源时，置 0 强度保证工作流可跑）
    try {
      const st2 = await comfyRuntime.status()
      if (st2.root) {
        const modelsRoot = fs.existsSync(path.join(st2.root, 'ComfyUI', 'models'))
          ? path.join(st2.root, 'ComfyUI', 'models')
          : path.join(st2.root, 'models')
        let changed2 = false
        for (const tpl of project.templates) {
          const d = degradeMissingLoras(tpl.apiJson, modelsRoot)
          if (d !== tpl.apiJson) {
            tpl.apiJson = d
            changed2 = true
          }
        }
        if (changed2) await store.flush()
      }
    } catch {
      // 降级失败不阻断打开
    }
    // 补全内置工作流（老项目缺失的图片/视频工作流，跟随软件自动补齐）
    await seedBuiltinTemplates(project)
    return project
  })
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

    // 按本机显存自动降级放大节点（6GB 卡不加载 12GB 放大模型，否则必然 OOM）
    const hw = await getHardware()
    apiJson = adaptTemplateForGpu(apiJson, hw.gpu)

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

  // ---- 整个工程导出 / 导入（含全部媒体文件）----
  ipcMain.handle(CH.projectExport, async (_e, payload: { id: string }) => {
    const projects = await store.list()
    const meta = projects.find((p) => p.id === payload.id)
    if (!meta) throw new Error('工程不存在')
    const project = store.getCurrent()?.id === payload.id ? store.getCurrent()! : await store.open(payload.id)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const safe = (meta.name || '工程').replace(/[\\/:*?"<>|]/g, '_')
    const res = await dialog.showSaveDialog(win!, {
      title: '导出整个工程',
      defaultPath: path.join(app.getPath('documents'), `${safe}.jxproj`),
      filters: [{ name: '镜序工坊工程包', extensions: ['jxproj'] }]
    })
    if (res.canceled || !res.filePath) return { cancelled: true }
    const out = await exportProjectToFile(project, res.filePath)
    // 导出后把当前工程恢复成原来那个（store.open 会切换当前）
    if (store.getCurrent()?.id !== payload.id) await store.open(payload.id)
    return { ok: true, ...out }
  })

  ipcMain.handle(CH.projectImport, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win!, {
      title: '导入工程包',
      properties: ['openFile'],
      filters: [{ name: '镜序工坊工程包', extensions: ['jxproj', 'zip'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return { cancelled: true }
    const existing = (await store.list()).map((p) => p.name)
    const r = await importProjectFromFile(res.filePaths[0], path.join(app.getPath('userData'), 'projects'), existing)
    const opened = await store.open(r.project.id)
    return { ok: true, project: opened, mediaCount: r.mediaCount }
  })

  // ---- 成片监视器 / 时间轴：整片视图 + 波形 ----
  ipcMain.handle(CH.cglideBase, async () => {
    const project = store.getCurrent()
    if (!project) return 'http://127.0.0.1:8188'
    return makeClient(project.settings.comfy).baseUrl()
  })
  ipcMain.handle(CH.cglideFilmSummary, async (_e, payload: { name: string }) => {
    const project = store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    try {
      return await makeClient(project.settings.comfy).filmSummary(payload.name)
    } catch (err) {
      return { error: String((err as Error).message ?? err) }
    }
  })
  ipcMain.handle(CH.cglideJoinWaveform, async (_e, payload: { video: string; bins?: number }) => {
    const project = store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    try {
      return await makeClient(project.settings.comfy).joinWaveform(payload.video, payload.bins ?? 1200)
    } catch (err) {
      return { error: String((err as Error).message ?? err) }
    }
  })

  // ---- H3 续拍存档：查某一段当前版本的 cont 路径（潜空间续写用）----
  ipcMain.handle(CH.h3ChainCont, async (_e, payload: { name: string; shot: string }) => {
    const project = store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    const client = makeClient(project.settings.comfy)
    try {
      const summary = await client.chainSummary(payload.name)
      const clip = summary.clips.find((c) => c.shot === payload.shot)
      if (!clip) return { error: '档案里还没有这一段（先跑一次这一段）' }
      const cont = await client.chainCont(payload.name, clip.id)
      return { ...cont, cid: clip.id, take: clip.current_take ?? cont.take }
    } catch (err) {
      return { error: String((err as Error).message ?? err) }
    }
  })

  // ---- 从 ComfyUI 网页端同步工作流（整份替换）----
  ipcMain.handle(CH.workflowSyncList, async () => {
    const project = store.getCurrent()
    const st = await comfyRuntime.status()
    const comfyRoot = st.root
    if (!comfyRoot) throw new Error('还没配置 ComfyUI 根目录，请先在设置里指定')
    const list = listComfyWorkflows(comfyRoot, project?.templates ?? null)
    return { comfyRoot, items: list }
  })
  ipcMain.handle(CH.workflowSyncApply, async (_e, payload: { files: string[] }) => {
    const project = store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    const hw = await getHardware()
    let replaced = 0
    let added = 0
    const failed: { file: string; error: string }[] = []
    for (const file of payload.files ?? []) {
      try {
        const wf = readComfyWorkflow(file)
        if (!wf) {
          failed.push({ file, error: '不是有效的 ComfyUI 工作流文件（缺 nodes）' })
          continue
        }
        // 按归一化名字匹配项目里已有的模板（容忍 emoji、大小写、版本号差异）
        const key = normalizeKey(wf.name)
        const existing = project.templates.find((t) => normalizeKey(t.name) === key)
        const adapted = adaptTemplateForGpu(wf.apiJson, hw.gpu)
        if (existing) {
          // 整份替换：以网页端为准
          existing.apiJson = adapted
          replaced++
        } else {
          const kind = detectWorkflowKind(
            (isUiWorkflow(wf.apiJson) ? {} : (wf.apiJson as Record<string, { class_type: string }>)) as Record<string, { class_type: string }>
          )
          project.templates.push({
            id: uid('tpl_'),
            name: wf.name,
            kind,
            apiJson: adapted,
            mapping: { version: 1 },
            createdAt: now()
          })
          added++
        }
      } catch (err) {
        failed.push({ file, error: String((err as Error).message ?? err) })
      }
    }
    await store.flush()
    return { replaced, added, failed }
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

  // 从剧本文本提取角色资产（只返回清单，不写工程；由界面让用户确认后再创建）
  ipcMain.handle(CH.aiExtractCharacters, async (_e, payload: { text: string }) => {
    const cfg = loadAiConfig()
    const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0]
    return aiAssistant.extractCharacters(provider, String(payload?.text ?? ''))
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

  // 导出成片：把一个已生成的成片文件另存到用户指定位置。
  // 时间轴「导出成片」用 —— 直接复制本地成片，不做二次编码（保留原画质）。
  ipcMain.handle(CH.filmExport, async (_e, payload: { source: string; suggestedName: string }) => {
    try {
      const src = path.resolve(payload.source)
      const stat = await fsp.stat(src).catch(() => null)
      if (!stat || !stat.isFile()) return { ok: false, error: '成片文件不存在' }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const ext = path.extname(src) || '.mp4'
      const safe = (payload.suggestedName || '成片').replace(/[\\/:*?"<>|]/g, '_')
      const res = await dialog.showSaveDialog(win!, {
        title: '导出成片',
        defaultPath: path.join(app.getPath('videos'), `${safe}${ext}`),
        filters: [{ name: '视频', extensions: [ext.replace('.', '')] }]
      })
      if (res.canceled || !res.filePath) return { cancelled: true }
      await fsp.copyFile(src, res.filePath)
      return { ok: true, outPath: res.filePath }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  })

  // 删除媒体文件（物理删除）。
  //
  // 为什么不能只看内存里的当前工程：渲染层刚保存完就立刻调用这里，而主进程的
  // `store.getCurrent()` 与磁盘上的 project.json 之间存在时序/缓存差异时，
  // 旧快照里还留着这张图 → 被判成「仍被引用」→ 静默不删，下次打开又出现。
  // 所以这里**以磁盘上的 project.json 为准**，并且扫描全部工程；
  // 只有确实没有任何工程引用它，才物理删除。删除失败会重试（杀毒/缩略图占用）。
  ipcMain.handle(CH.mediaDeleteFile, async (_e, p: string) => {
    try {
      if (!p) return { deleted: false, reason: '没有文件路径' }
      const abs = path.resolve(p)
      const key = abs.toLowerCase()
      const projectsDir = path.join(app.getPath('userData'), 'projects')

      const collectRefs = (proj: Project): { cover: string[]; images: string[]; outputs: string[] } => {
        const cover: string[] = []
        const images: string[] = []
        const outputs: string[] = []
        for (const a of proj.assets ?? []) {
          if (a.coverFile) cover.push(path.resolve(a.coverFile).toLowerCase())
          for (const i of a.images ?? []) if (i) images.push(path.resolve(i).toLowerCase())
          for (const v of (a as { versions?: { file?: string }[] }).versions ?? []) {
            if (v?.file) images.push(path.resolve(v.file).toLowerCase())
          }
        }
        for (const s of proj.shots ?? []) {
          for (const o of s.outputs ?? []) if (o?.file) outputs.push(path.resolve(o.file).toLowerCase())
          const ref = (s as { refImage?: string }).refImage
          if (ref) images.push(path.resolve(ref).toLowerCase())
        }
        return { cover, images, outputs }
      }

      // 扫描所有工程（磁盘为准），确认没有别的地方还在用这个文件
      let usedBy = ''
      let entries: string[] = []
      try {
        entries = (await fsp.readdir(projectsDir, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch {
        entries = []
      }
      for (const dir of entries) {
        const file = path.join(projectsDir, dir, 'project.json')
        try {
          const raw = await fsp.readFile(file, 'utf8')
          const proj = JSON.parse(raw) as Project
          const refs = collectRefs(proj)
          if ([...refs.cover, ...refs.images, ...refs.outputs].includes(key)) {
            usedBy = proj.name || dir
            break
          }
        } catch {
          continue
        }
      }
      if (usedBy) return { deleted: false, reason: `该文件仍被「${usedBy}」使用` }

      // 物理删除（重试，处理缩略图/杀毒短暂占用）
      let lastErr = ''
      for (let i = 0; i < 4; i++) {
        try {
          await fsp.rm(abs, { force: true })
          if (!fs.existsSync(abs)) return { deleted: true }
        } catch (err) {
          lastErr = String((err as Error).message ?? err)
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!fs.existsSync(abs)) return { deleted: true }
      return { deleted: false, reason: lastErr || '文件仍存在（可能被其它程序占用）' }
    } catch (err) {
      return { deleted: false, reason: String((err as Error).message ?? err) }
    }
  })

  // 清理当前工程 media/ 里「没有任何引用」的孤儿文件（生成中断、改名残留等）。
  // 只删 10 分钟以前的，避免和正在下载/写入的生成任务抢文件。
  const cleanupOrphansNow = async (): Promise<{ removed: number }> => {
    const project = store.getCurrent()
    if (!project) return { removed: 0 }
    const media = store.mediaDir()
    const refs = new Set<string>()
    for (const a of project.assets ?? []) {
      if (a.coverFile) refs.add(path.resolve(a.coverFile).toLowerCase())
      for (const i of a.images ?? []) if (i) refs.add(path.resolve(i).toLowerCase())
      for (const v of (a as { versions?: { file?: string }[] }).versions ?? []) {
        if (v?.file) refs.add(path.resolve(v.file).toLowerCase())
      }
    }
    for (const s of project.shots ?? []) {
      for (const o of s.outputs ?? []) if (o?.file) refs.add(path.resolve(o.file).toLowerCase())
      const ref = (s as { refImage?: string }).refImage
      if (ref) refs.add(path.resolve(ref).toLowerCase())
    }
    let removed = 0
    let list: string[] = []
    try { list = await fsp.readdir(media) } catch { return { removed: 0 } }
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const name of list) {
      const abs = path.join(media, name)
      if (refs.has(path.resolve(abs).toLowerCase())) continue
      try {
        const st = await fsp.stat(abs)
        if (!st.isFile() || st.mtimeMs > cutoff) continue
        await fsp.rm(abs, { force: true })
        removed += 1
      } catch { continue }
    }
    return { removed }
  }

  ipcMain.handle(CH.mediaCleanupOrphans, async () => {
    try {
      return await cleanupOrphansNow()
    } catch (err) {
      return { removed: 0, error: String((err as Error).message ?? err) }
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

  // AI 助手：内置技能目录 + 全局 AI 配置
  skillsRoot = app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(app.getAppPath(), 'skills')
  aiConfigFile = path.join(app.getPath('userData'), 'ai-config.json')
  aiAssistant = new AiAssistant(store, skillsRoot)

  jobs = new JobManager(store, (type, payload) => {
    push({ type, ...(payload as Record<string, unknown>) } as PushEvent)
  })

  updater.setEmitter((payload) => push(payload))


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

// 退出前必须等待未落盘的改动写完，否则关闭瞬间的保存会丢失。
// flush 内部串行排队，等待它即可保证最后一次快照写盘完成。
let quitting = false
app.on('before-quit', (event) => {
  if (!store || quitting) return
  event.preventDefault()
  quitting = true
  void store.flush().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // 走 app.quit() 触发 before-quit，等落盘完成后再真正退出（保持原有「关窗即退出」行为）
  app.quit()
})

export type { UpdateInfo }
