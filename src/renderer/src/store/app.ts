import { create } from 'zustand'
import type {
  ComfySettings,
  ComfySystemStats,
  HardwareReport,
  JobInfo,
  Project,
  Template,
  UpdateInfo
} from '@shared/types'

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
    const s = settings ?? get().project?.settings.comfy
    const comfy = await window.api.comfyStatus(s)
    set({ comfy })
  },

  testComfy: async (settings) => window.api.comfyTest(settings ?? get().project?.settings.comfy),

  openProject: async (id) => {
    const project = await window.api.projectOpen(id)
    set({ project })
  },

  createProject: async (name) => {
    const project = await window.api.projectCreate(name)
    set({ project })
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
