/**
 * IPC 通道常量。主进程、preload、渲染进程统一从这里引用，
 * 避免魔法字符串散落各处。
 */
export const CH = {
  appInfo: 'app:info',
  hardwareDetect: 'hardware:detect',
  comfyStatus: 'comfy:status',
  comfyTest: 'comfy:test',
  envScan: 'env:scan',
  envCatalog: 'env:catalog',
  envExtract: 'env:extract',
  comfyRuntimeStatus: 'runtime:status',
  comfyRuntimeStart: 'runtime:start',
  comfyRuntimeStop: 'runtime:stop',
  comfyRuntimeSetConfig: 'runtime:set-config',
  comfyInstallStart: 'comfy-install:start',
  comfyInstallState: 'comfy-install:state',
  projectList: 'project:list',
  projectOpen: 'project:open',
  projectCreate: 'project:create',
  projectSave: 'project:save',
  projectGetCurrent: 'project:get-current',
  projectImportTemplate: 'project:import-template',
  memoryList: 'memory:list',
  memoryRead: 'memory:read',
  memoryWrite: 'memory:write',
  memoryAppend: 'memory:append',
  aiGetConfig: 'ai:get-config',
  aiSetConfig: 'ai:set-config',
  aiChat: 'ai:chat',
  aiTest: 'ai:test',
  aiListModels: 'ai:list-models',
  aiCancel: 'ai:cancel',
  mediaDataUrl: 'media:data-url',
  mediaDeleteFile: 'media:delete-file',
  jobGenerate: 'job:generate',
  jobList: 'job:list',
  jobCancel: 'job:cancel',
  jobRetry: 'job:retry',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateInfo: 'update:info',
  downloadStart: 'download:start',
  downloadList: 'download:list',
  downloadCancel: 'download:cancel',
  shellOpenPath: 'shell:open-path',
  event: 'event:push'
} as const

export type IpcChannel = (typeof CH)[keyof typeof CH]

/** 主进程 -> 渲染进程 推送事件负载 */
export type PushEvent =
  | { type: 'job:updated'; job: import('./types').JobInfo }
  | { type: 'job:progress'; jobId: string; progress: number; node?: string }
  | { type: 'comfy:status'; status: import('./types').ComfySystemStats }
  | { type: 'update:state'; info: import('./types').UpdateInfo }
  | { type: 'download:state'; task: import('./types').DownloadTask }
  | { type: 'comfy:runtime'; state: import('./types').ComfyRuntimeState }
  | { type: 'comfy:install'; state: import('./types').ComfyInstallState }
  | { type: 'ai:status'; text: string }
  | { type: 'ai:tool'; name: string; args: Record<string, unknown>; summary?: string }
  | { type: 'ai:done'; changed: boolean }
  | { type: 'ai:error'; message: string }
