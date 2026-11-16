import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { useApp } from './store/app'
import Dashboard from './pages/Dashboard'
import Environment from './pages/Environment'
import Assets from './pages/Assets'
import Storyboard from './pages/Storyboard'
import Director from './pages/Director'
import Memory from './pages/Memory'
import AiAssistant from './pages/AiAssistant'
import Queue from './pages/Queue'
import Settings from './pages/Settings'

export default function App(): React.JSX.Element {
  const loadHardware = useApp((s) => s.loadHardware)
  const refreshJobs = useApp((s) => s.refreshJobs)
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

    const off = window.api.onEvent((event) => {
      if (event.type === 'job:updated' || event.type === 'job:progress') {
        void refreshJobs()
      }
      if (event.type === 'update:state') {
        useApp.setState({ update: event.info })
      }
    })
    return off
  }, [loadHardware, refreshJobs, loadUpdate, openProject])

  const location = useLocation()
  if (location.pathname === '/') return <Navigate to="/dashboard" replace />

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/environment" element={<Environment />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/storyboard" element={<Storyboard />} />
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
