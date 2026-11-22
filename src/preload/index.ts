import { contextBridge, ipcRenderer } from 'electron'
import { CH, type PushEvent } from '../shared/ipc'
import type {
  ComfyRuntimeConfig,
  ComfyRuntimeState,
  DownloadTask,
  HardwareReport,
  JobParams,
  Project,
  ComfySettings,
  UpdateInfo,
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

  comfyRuntimeStatus: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStatus),
  comfyRuntimeStart: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStart),
  comfyRuntimeStop: (): Promise<ComfyRuntimeState> => ipcRenderer.invoke(CH.comfyRuntimeStop),
  comfyRuntimeSetConfig: (cfg: ComfyRuntimeConfig): Promise<ComfyRuntimeConfig> =>
    ipcRenderer.invoke(CH.comfyRuntimeSetConfig, cfg),

  projectList: () => ipcRenderer.invoke(CH.projectList),
  projectOpen: (id: string): Promise<Project> => ipcRenderer.invoke(CH.projectOpen, id),
  projectCreate: (name: string): Promise<Project> => ipcRenderer.invoke(CH.projectCreate, name),
  projectSave: (project: Project): Promise<Project> => ipcRenderer.invoke(CH.projectSave, project),
  projectGetCurrent: (): Promise<Project | null> => ipcRenderer.invoke(CH.projectGetCurrent),
  projectExport: (id: string): Promise<{ cancelled?: boolean; ok?: boolean; outPath?: string; mediaCount?: number; totalBytes?: number }> =>
    ipcRenderer.invoke(CH.projectExport, { id }),
  projectImport: (): Promise<{ cancelled?: boolean; ok?: boolean; project?: unknown; mediaCount?: number }> =>
    ipcRenderer.invoke(CH.projectImport),
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
  aiExtractCharacters: (payload: { text: string }): Promise<{
    name: string; alias: string; description: string; prompt: string; tags: string[]
  }[]> => ipcRenderer.invoke(CH.aiExtractCharacters, payload),
  aiTest: (providerId?: string): Promise<{ ok: boolean; message: string; url?: string; latencyMs?: number; reply?: string }> =>
    ipcRenderer.invoke(CH.aiTest, providerId),
  aiListModels: (providerId?: string): Promise<{ ok: boolean; models: string[]; message?: string }> =>
    ipcRenderer.invoke(CH.aiListModels, providerId),

  mediaDataUrl: (p: string): Promise<string | null> => ipcRenderer.invoke(CH.mediaDataUrl, p),
  filmExport: (source: string, suggestedName: string): Promise<{ cancelled?: boolean; ok?: boolean; outPath?: string; error?: string }> =>
    ipcRenderer.invoke(CH.filmExport, { source, suggestedName }),
  mediaDeleteFile: (p: string): Promise<{ deleted: boolean; reason?: string }> =>
    ipcRenderer.invoke(CH.mediaDeleteFile, p),
  mediaCleanupOrphans: (): Promise<{ removed: number; error?: string }> =>
    ipcRenderer.invoke(CH.mediaCleanupOrphans),

  jobGenerate: (params: JobParams) => ipcRenderer.invoke(CH.jobGenerate, params),
  jobList: () => ipcRenderer.invoke(CH.jobList),
  jobCancel: (jobId: string) => ipcRenderer.invoke(CH.jobCancel, jobId),
  jobRetry: (jobId: string) => ipcRenderer.invoke(CH.jobRetry, jobId),

  updateInfo: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateInfo),
  updateCheck: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateCheck),
  updateDownload: (): Promise<UpdateInfo> => ipcRenderer.invoke(CH.updateDownload),
  updateInstall: () => ipcRenderer.invoke(CH.updateInstall),

  cglideBase: (): Promise<string> => ipcRenderer.invoke(CH.cglideBase),
  cglideFilmSummary: (name: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(CH.cglideFilmSummary, { name }),
  cglideJoinWaveform: (video: string, bins?: number): Promise<{ bins?: number[]; duration?: number; error?: string }> =>
    ipcRenderer.invoke(CH.cglideJoinWaveform, { video, bins }),
  h3ChainCont: (name: string, shot: string): Promise<{ cont_path?: string; cid?: string; take?: number; error?: string }> =>
    ipcRenderer.invoke(CH.h3ChainCont, { name, shot }),
  workflowSyncList: (): Promise<{ comfyRoot: string; items: unknown[] }> =>
    ipcRenderer.invoke(CH.workflowSyncList),
  workflowSyncApply: (files: string[]): Promise<{ replaced: number; added: number; failed: unknown[] }> =>
    ipcRenderer.invoke(CH.workflowSyncApply, { files }),

  downloadList: (): Promise<DownloadTask[]> => ipcRenderer.invoke(CH.downloadList),

  openPath: (p: string) => ipcRenderer.invoke(CH.shellOpenPath, p),

  onEvent: (cb: (event: PushEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: PushEvent): void => cb(payload)
    ipcRenderer.on(CH.event, listener)
    return () => ipcRenderer.removeListener(CH.event, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type FrameForgeApi = typeof api
