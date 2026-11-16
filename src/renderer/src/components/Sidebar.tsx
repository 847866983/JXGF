import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Activity,
  BookOpen,
  Bot,
  Clapperboard,
  Film,
  FolderKanban,
  LayoutDashboard,
  ListOrdered,
  Server,
  Settings,
  Sparkles
} from 'lucide-react'
import type { ProjectSummary } from '@shared/types'
import { useApp } from '../store/app'

const items = [
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/environment', label: '环境检测', icon: Activity },
  { to: '/assets', label: '资产管理', icon: FolderKanban },
  { to: '/storyboard', label: '剧本分镜', icon: ListOrdered },
  { to: '/memory', label: '记忆库', icon: BookOpen },
  { to: '/ai', label: 'AI 助手', icon: Bot },
  { to: '/director', label: '导演台', icon: Clapperboard },
  { to: '/queue', label: '生成队列', icon: Film },
  { to: '/settings', label: '设置', icon: Settings }
]

export function Sidebar(): React.JSX.Element {
  const project = useApp((s) => s.project)
  const comfy = useApp((s) => s.comfy)
  const refreshComfy = useApp((s) => s.refreshComfy)
  const listProjects = useApp((s) => s.listProjects)
  const openProject = useApp((s) => s.openProject)

  const [projects, setProjects] = useState<ProjectSummary[]>([])

  // 每 5 秒刷新一次 ComfyUI 运行信息
  useEffect(() => {
    void refreshComfy()
    const timer = setInterval(() => void refreshComfy(), 5000)
    return () => clearInterval(timer)
  }, [refreshComfy])

  // 加载项目列表（用于切换）
  useEffect(() => {
    void listProjects().then(setProjects)
  }, [listProjects, project?.id])

  // 字节 -> 人类可读
  const gb = (bytes?: number): string => (bytes !== undefined && bytes > 0 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB` : '—')
  // 占用百分比（total - free）/ total
  const pct = (total?: number, free?: number): number =>
    total && total > 0 && free !== undefined ? Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100))) : 0

  const ramTotal = comfy?.ram?.total
  const ramFree = comfy?.ram?.free
  const ramUsed = ramTotal !== undefined && ramFree !== undefined ? ramTotal - ramFree : 0
  const ramPct = pct(ramTotal, ramFree)

  const vramTotal = comfy?.gpu?.vramTotal
  const vramFree = comfy?.gpu?.vramFree
  const vramPct = pct(vramTotal, vramFree)

  const bar = (percent: number, tone: string): React.JSX.Element => (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  )

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-ink-900">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-600 text-white shadow-lg shadow-accent-600/30">
          <Sparkles size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-wide text-white">镜序工坊</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">JingXu Studio</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'bg-accent-600/15 text-accent-400'
                  : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
              }`
            }
          >
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* ComfyUI 运行信息 */}
      <div className="border-t border-white/5 px-4 py-3">
        <div className="rounded-lg bg-ink-850 p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500">
            <Server size={11} />
            ComfyUI
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                comfy?.online ? 'bg-emerald-400' : 'bg-rose-500'
              }`}
            />
            <span className={`text-sm font-medium ${comfy?.online ? 'text-emerald-300' : 'text-rose-400'}`}>
              {comfy?.online ? '运行中' : '未连接'}
            </span>
          </div>
          {comfy?.online && (
            <div className="mt-2 space-y-2 text-[11px] text-slate-400">
              <div className="flex justify-between">
                <span>版本</span>
                <span className="text-slate-300">v{comfy.version}</span>
              </div>
              {comfy.gpu?.name && (
                <div className="flex justify-between">
                  <span>显卡</span>
                  <span className="max-w-[120px] truncate text-slate-300">{comfy.gpu.name}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>队列</span>
                <span className="text-slate-300">
                  {comfy.queueRunning} 运行 / {comfy.queueRemaining} 等待
                </span>
              </div>

              {/* 显存占用 */}
              {vramTotal !== undefined && vramTotal > 0 && (
                <div>
                  <div className="flex justify-between">
                    <span>显存占用</span>
                    <span className="text-slate-300">
                      {gb(vramTotal - (vramFree ?? 0))} / {gb(vramTotal)} · {vramPct}%
                    </span>
                  </div>
                  {bar(vramPct, vramPct > 90 ? 'bg-rose-500' : vramPct > 70 ? 'bg-amber-500' : 'bg-accent-500')}
                </div>
              )}

              {/* 内存占用 */}
              {ramTotal !== undefined && ramTotal > 0 && (
                <div>
                  <div className="flex justify-between">
                    <span>内存占用</span>
                    <span className="text-slate-300">
                      {gb(ramUsed)} / {gb(ramTotal)} · {ramPct}%
                    </span>
                  </div>
                  {bar(ramPct, ramPct > 90 ? 'bg-rose-500' : ramPct > 70 ? 'bg-amber-500' : 'bg-accent-500')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/5 p-4">
        <div className="rounded-lg bg-ink-850 p-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">当前项目</div>
          <select
            className="field mt-1.5 w-full"
            value={project?.id ?? ''}
            onChange={(e) => {
              const id = e.target.value
              if (id) void openProject(id)
            }}
          >
            {projects.length === 0 ? (
              <option value="">未打开项目</option>
            ) : (
              <>
                {!project && <option value="">选择项目…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>
      </div>
    </aside>
  )
}
