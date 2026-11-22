import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { useApp } from './store/app'
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
      if (event.type === 'job:updated' && (event as { job?: { status?: string } }).job?.status === 'done') {
        const snap = (event as { project?: unknown }).project
        if (snap) {
          useApp.setState({ project: snap as never })
        } else {
          const pid = useApp.getState().project?.id
          if (pid) void useApp.getState().openProject(pid).catch(() => undefined)
        }
      }
      if (event.type === 'update:state') {
        useApp.setState({ update: event.info })
      }
    })
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
      </main>
    </div>
  )
}
