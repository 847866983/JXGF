import { create } from 'zustand'
import type {
  ComfySettings,
  ComfySystemStats,
  HardwareReport,
  JobInfo,
  Project,
  ProjectSummary,
  Template,
  UpdateInfo
} from '@shared/types'

/** comfyStatus 在途标记（模块级单例，防止并发重复请求） */
let comfyInFlight = false

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
  project: Project | null
  jobs: JobInfo[]
  update: UpdateInfo | null
  hardwareLoading: boolean
  loadHardware: () => Promise<void>
  refreshComfy: (settings?: ComfySettings) => Promise<void>
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
  project: null,
  jobs: [],
  update: null,
  hardwareLoading: false,

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
