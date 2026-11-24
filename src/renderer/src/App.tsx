import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { useApp } from './store/app'
import type { Notice } from './store/app'
import Dashboard from './pages/Dashboard'
import Assets from './pages/Assets'
import Director from './pages/Director'
import Memory from './pages/Memory'
import AiAssistant from './pages/AiAssistant'
import Queue from './pages/Queue'
import Settings from './pages/Settings'

export default function App(): React.JSX.Element {
  const loadHardware = useApp((s) => s.loadHardware)
  const refreshJobs = useApp((s) => s.refreshJobs)
  const refreshComfy = useApp((s) => s.refreshComfy)
  const loadUpdate = useApp((s) => s.loadUpdate)
  const openProject = useApp((s) => s.openProject)

  useEffect(() => {
    void loadHardware()
    void refreshJobs()
    void loadUpdate()

    // 启动时自动打开上次的项目
    if (!useApp.getState().project) {
      const last = localStorage.getItem('jxgf:lastProject')
      if (last) void openProject(last).catch(() => undefined)
    }

    // ComfyUI 运行信息：全局单一轮询源（Sidebar / Dashboard / Settings 不再各自起定时器）
    // 用递归 setTimeout 而非 setInterval：保证上一轮结束后才排下一轮，请求永不堆积；
    // 页面隐藏时暂停，回到前台立刻刷新。有生成任务在跑时加快到 1.5s。
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let pollStopped = false
    const pollComfy = async (): Promise<void> => {
      if (pollStopped) return
      if (!document.hidden) await refreshComfy()
      if (pollStopped) return
      const jobs = useApp.getState().jobs
      const busy = jobs.some((j) => j.status === 'running' || j.status === 'queued')
      pollTimer = setTimeout(() => void pollComfy(), busy ? 1500 : 3000)
    }
    void pollComfy()
    const onVisible = (): void => {
      if (!document.hidden) void refreshComfy()
    }
    document.addEventListener('visibilitychange', onVisible)

    const off = window.api.onEvent((event) => {
      if (event.type === 'job:updated' || event.type === 'job:progress') {
        void refreshJobs()
      }
      // 生成任务完成后，用主进程随事件带来的最新项目快照直接刷新（避免重读磁盘的竞态）
      if (event.type === 'job:updated' && event.job?.status === 'done') {
        const snap = event.project
        if (snap) {
          useApp.setState({ project: snap })
        } else {
          const pid = useApp.getState().project?.id
          if (pid) void useApp.getState().openProject(pid).catch(() => undefined)
        }
      }
      if (event.type === 'update:state') {
        useApp.setState({ update: event.info })
      }
      // ComfyUI 运行时状态（启动/停止后主进程推送），设置页实时显示
      if (event.type === 'comfy:runtime') {
        useApp.setState({ comfyRuntime: event.state })
      }
    })
    // 初始拉一次运行时状态（事件只在变化时推送，首次进入需要主动取）
    void useApp.getState().refreshComfyRuntime()
    return () => {
      pollStopped = true
      if (pollTimer) clearTimeout(pollTimer)
      document.removeEventListener('visibilitychange', onVisible)
      off()
    }
  }, [loadHardware, refreshJobs, refreshComfy, loadUpdate, openProject])

  const location = useLocation()
  if (location.pathname === '/') return <Navigate to="/dashboard" replace />

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div key={location.pathname} className="page-enter h-full">
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/environment" element={<Navigate to="/settings" replace />} />
            <Route path="/assets" element={<Assets />} />
            {/* 剧本分镜已整合进导演台；旧链接 /storyboard 重定向过去，避免白屏 */}
            <Route path="/storyboard" element={<Navigate to="/director?tab=storyboard" replace />} />
            <Route path="/director" element={<Director />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/ai" element={<AiAssistant />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
      <ToastStack />
    </div>
  )
}

/** 全局通知中心：右上角 Toast 栈，点击可关闭，4s 自动消失（见 store.pushNotice） */
function ToastStack(): React.JSX.Element {
  const notices = useApp((s) => s.notices)
  const dismissNotice = useApp((s) => s.dismissNotice)

  const tone = (t: Notice['type']): { fg: string; bg: string; icon: React.ReactNode } => {
    switch (t) {
      case 'ok':
        return { fg: 'var(--c-ok)', bg: 'rgba(52, 211, 153, 0.08)', icon: <CheckCircle2 size={15} /> }
      case 'warn':
        return { fg: 'var(--c-warn)', bg: 'rgba(251, 191, 36, 0.08)', icon: <AlertTriangle size={15} /> }
      case 'danger':
        return { fg: 'var(--c-danger)', bg: 'rgba(251, 113, 133, 0.08)', icon: <XCircle size={15} /> }
      default:
        return { fg: 'var(--c-busy)', bg: 'rgba(155, 130, 255, 0.08)', icon: <Loader2 size={15} className="animate-spin" /> }
    }
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[22rem] flex-col gap-2">
      {notices.map((n) => {
        const t = tone(n.type)
        return (
          <button
            key={n.id}
            className="toast-enter pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left shadow-panel transition-opacity hover:opacity-90"
            style={{ borderColor: `${t.fg}55`, backgroundColor: t.bg, color: t.fg }}
            onClick={() => dismissNotice(n.id)}
            title="点击关闭"
          >
            <span className="mt-0.5 shrink-0">{t.icon}</span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-slate-200">{n.text}</span>
          </button>
        )
      })}
    </div>
  )
}
