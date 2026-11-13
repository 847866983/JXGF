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
  projectList: 'project:list',
  projectOpen: 'project:open',
  projectCreate: 'project:create',
  projectSave: 'project:save',
  projectImportTemplate: 'project:import-template',
  jobGenerate: 'job:generate',
  jobList: 'job:list',
  jobCancel: 'job:cancel',
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
