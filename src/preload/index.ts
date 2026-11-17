import { contextBridge, ipcRenderer } from 'electron'
import { CH, type PushEvent } from '../shared/ipc'
import type {
  CatalogItem,
  ComfyRuntimeConfig,
  ComfyRuntimeState,
  DownloadRequest,
  DownloadTask,
  EnvironmentReport,
  HardwareReport,
  JobParams,
  Project,
  ComfySettings,
  UpdateInfo
} from '../shared/types'

const api = {
  appInfo: (): Promise<{
    name: string
    version: string
    packaged: boolean
    userData: string
    platform: string
    mcp: {
      command: string
      args: string[]
      env: Record<string, string>
      script: string
      projectsDir: string
      note: string
    }
  }> => ipcRenderer.invoke(CH.appInfo),

  hardwareDetect: (): Promise<HardwareReport> => ipcRenderer.invoke(CH.hardwareDetect),

  comfyStatus: (settings?: ComfySettings) => ipcRenderer.invoke(CH.comfyStatus, settings),
  comfyTest: (settings?: ComfySettings) => ipcRenderer.invoke(CH.comfyTest, settings),
  envScan: (): Promise<EnvironmentReport> => ipcRenderer.invoke(CH.envScan),
  envCatalog: (): Promise<CatalogItem[]> => ipcRenderer.invoke(CH.envCatalog),
  envExtract: (payload: { archive: string; dest: string }): Promise<{ dest: string }> =>
    ipcRenderer.invoke(CH.envExtract, payload),

  comfyRuntimeStatus: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStatus),
  comfyRuntimeStart: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStart),
  comfyRuntimeStop: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStop),
  comfyRuntimeSetConfig: (cfg: ComfyRuntimeConfig): Promise<ComfyRuntimeConfig> =>
    ipcRenderer.invoke(CH.comfyRuntimeSetConfig, cfg),
  comfyInstallStart: (): Promise<ComfyRuntimeState | import('../shared/types').ComfyInstallState> =>
    ipcRenderer.invoke(CH.comfyInstallStart),
  nodePackStatus: (comfyRoot: string): Promise<unknown> => ipcRenderer.invoke(CH.nodePackStatus, comfyRoot),
  nodePackInstall: (comfyRoot: string): Promise<unknown> => ipcRenderer.invoke(CH.nodePackInstall, comfyRoot),

  projectList: () => ipcRenderer.invoke(CH.projectList),
  projectOpen: (id: string): Promise<Project> => ipcRenderer.invoke(CH.projectOpen, id),
  projectCreate: (name: string): Promise<Project> => ipcRenderer.invoke(CH.projectCreate, name),
  projectSave: (project: Project): Promise<Project> => ipcRenderer.invoke(CH.projectSave, project),
  projectGetCurrent: (): Promise<Project | null> => ipcRenderer.invoke(CH.projectGetCurrent),
  projectImportTemplate: (payload: { name: string; kind?: 'image' | 'video'; apiJson: unknown }) =>
    ipcRenderer.invoke(CH.projectImportTemplate, payload),

  memoryList: (): Promise<import('../shared/memory').MemoryEntry[]> => ipcRenderer.invoke(CH.memoryList),
  memoryRead: (key: string): Promise<string> => ipcRenderer.invoke(CH.memoryRead, key),
  memoryWrite: (key: string, content: string): Promise<void> => ipcRenderer.invoke(CH.memoryWrite, key, content),
  memoryAppend: (key: string, text: string): Promise<void> => ipcRenderer.invoke(CH.memoryAppend, key, text),

  aiGetConfig: (): Promise<import('../shared/ai').AiConfig> => ipcRenderer.invoke(CH.aiGetConfig),
  aiSetConfig: (cfg: import('../shared/ai').AiConfig): Promise<import('../shared/ai').AiConfig> =>
    ipcRenderer.invoke(CH.aiSetConfig, cfg),
  aiChat: (payload: {
    messages: { role: 'user' | 'assistant'; content: string }[]
  }): Promise<{ content: string; changed: boolean }> => ipcRenderer.invoke(CH.aiChat, payload),
  aiTest: (providerId?: string): Promise<{ ok: boolean; message: string; url?: string; latencyMs?: number; reply?: string }> =>
    ipcRenderer.invoke(CH.aiTest, providerId),
  aiListModels: (providerId?: string): Promise<{ ok: boolean; models: string[]; message?: string }> =>
    ipcRenderer.invoke(CH.aiListModels, providerId),

  mediaDataUrl: (p: string): Promise<string | null> => ipcRenderer.invoke(CH.mediaDataUrl, p),
  mediaDeleteFile: (p: string): Promise<{ deleted: boolean; reason?: string }> =>
    ipcRenderer.invoke(CH.mediaDeleteFile, p),

  jobGenerate: (params: JobParams) => ipcRenderer.invoke(CH.jobGenerate, params),
  jobList: () => ipcRenderer.invoke(CH.jobList),
  jobCancel: (jobId: string) => ipcRenderer.invoke(CH.jobCancel, jobId),
  jobRetry: (jobId: string) => ipcRenderer.invoke(CH.jobRetry, jobId),

  updateInfo: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateInfo),
  updateCheck: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateCheck),
  updateDownload: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateDownload),
  updateInstall: () => ipcRenderer.invoke(CH.updateInstall),

  downloadStart: (req: DownloadRequest): Promise<DownloadTask> => ipcRenderer.invoke(CH.downloadStart, req),
  downloadList: (): Promise<DownloadTask[]> => ipcRenderer.invoke(CH.downloadList),
  downloadCancel: (id: string) => ipcRenderer.invoke(CH.downloadCancel, id),

  openPath: (p: string) => ipcRenderer.invoke(CH.shellOpenPath, p),

  onEvent: (cb: (event: PushEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: PushEvent): void => cb(payload)
    ipcRenderer.on(CH.event, listener)
    return () => ipcRenderer.removeListener(CH.event, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type FrameForgeApi = typeof api
