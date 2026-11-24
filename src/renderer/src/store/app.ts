import { create } from 'zustand'
import type {
  ComfySettings,
  ComfySystemStats,
  ComfyRuntimeState,
  HardwareReport,
  JobInfo,
  Project,
  ProjectSummary,
  Template,
  UpdateInfo
} from '@shared/types'

/** comfyStatus 在途标记（模块级单例，防止并发重复请求） */
let comfyInFlight = false

/** 通知自增 id（模块级，保证唯一） */
let noticeSeq = 1

/** 全局通知类型（纯 UI 状态，不影响业务数据流） */
export type NoticeType = 'ok' | 'warn' | 'danger' | 'busy'

export interface Notice {
  id: number
  type: NoticeType
  text: string
}

/** 比较两次状态的关键字段是否一致，避免无意义重渲染 */
function comfyStatsEqual(a: ComfySystemStats | null, b: ComfySystemStats | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.online === b.online &&
    a.version === b.version &&
    a.cpuAvailable === b.cpuAvailable &&
    a.queueRunning === b.queueRunning &&
    a.queueRemaining === b.queueRemaining &&
    a.gpu?.name === b.gpu?.name &&
    a.gpu?.vramTotal === b.gpu?.vramTotal &&
    a.gpu?.vramFree === b.gpu?.vramFree &&
    a.ram?.total === b.ram?.total &&
    a.ram?.free === b.ram?.free
  )
}

interface AppState {
  hardware: HardwareReport | null
  comfy: ComfySystemStats | null
  /** ComfyUI 运行时状态（未安装/已安装/运行中/已停止），由 comfy:runtime 事件与主动刷新维护 */
  comfyRuntime: ComfyRuntimeState | null
  project: Project | null
  jobs: JobInfo[]
  update: UpdateInfo | null
  hardwareLoading: boolean
  /** 全局通知中心（右上角 Toast 栈），纯 UI 状态 */
  notices: Notice[]
  pushNotice: (type: NoticeType, text: string) => void
  dismissNotice: (id: number) => void
  loadHardware: () => Promise<void>
  refreshComfy: (settings?: ComfySettings) => Promise<void>
  refreshComfyRuntime: () => Promise<ComfyRuntimeState | null>
  testComfy: (settings?: ComfySettings) => Promise<{ ok: boolean; version: string; error: string | null }>
  listProjects: () => Promise<ProjectSummary[]>
  openProject: (id: string) => Promise<void>
  createProject: (name: string) => Promise<void>
  saveProject: (project: Project) => Promise<void>
  importTemplate: (name: string, kind: 'image' | 'video' | undefined, apiJson: unknown) => Promise<void>
  refreshJobs: () => Promise<void>
  loadUpdate: () => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  hardware: null,
  comfy: null,
  comfyRuntime: null,
  project: null,
  jobs: [],
  update: null,
  hardwareLoading: false,
  notices: [],

  pushNotice: (type, text) => {
    const id = noticeSeq++
    // 最多保留 5 条，避免长时间操作把栈撑爆
    set((s) => ({ notices: [...s.notices.slice(-4), { id, type, text }] }))
    window.setTimeout(() => get().dismissNotice(id), 4000)
  },

  dismissNotice: (id) => {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
  },

  loadHardware: async () => {
    set({ hardwareLoading: true })
    try {
      const hardware = await window.api.hardwareDetect()
      set({ hardware })
    } finally {
      set({ hardwareLoading: false })
    }
  },

  refreshComfy: async (settings) => {
    // 并发去重：同一时刻只允许一个 comfyStatus 在飞，避免多处轮询错开时请求堆积
    if (comfyInFlight) return
    comfyInFlight = true
    try {
      const s = settings ?? get().project?.settings.comfy
      const comfy = await window.api.comfyStatus(s)
      // 值没变就不 set —— 否则每轮都新建对象，触发所有订阅组件重渲染（卡顿主因）
      const prev = get().comfy
      if (!comfyStatsEqual(prev, comfy)) set({ comfy })
    } finally {
      comfyInFlight = false
    }
  },

  refreshComfyRuntime: async () => {
    try {
      const runtime = await window.api.comfyRuntimeStatus()
      set({ comfyRuntime: runtime })
      return runtime
    } catch {
      return null
    }
  },

  testComfy: async (settings) => window.api.comfyTest(settings ?? get().project?.settings.comfy),

  listProjects: async () => window.api.projectList(),

  openProject: async (id) => {
    const project = await window.api.projectOpen(id)
    set({ project })
    try {
      localStorage.setItem('jxgf:lastProject', id)
    } catch {
      // ignore
    }
  },

  createProject: async (name) => {
    const project = await window.api.projectCreate(name)
    set({ project })
    try {
      localStorage.setItem('jxgf:lastProject', project.id)
    } catch {
      // ignore
    }
  },

  saveProject: async (project) => {
    const saved = await window.api.projectSave(project)
    set({ project: saved })
  },

  importTemplate: async (name, kind, apiJson) => {
    const tpl = (await window.api.projectImportTemplate({ name, kind, apiJson })) as Template
    const project = get().project
    if (project) {
      set({ project: { ...project, templates: [...project.templates, tpl] } })
    }
  },

  refreshJobs: async () => {
    set({ jobs: await window.api.jobList() })
  },

  loadUpdate: async () => {
    set({ update: await window.api.updateInfo() })
  }
}))
