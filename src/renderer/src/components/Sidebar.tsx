import { NavLink } from 'react-router-dom'
import {
  Activity,
  Clapperboard,
  Film,
  FolderKanban,
  LayoutDashboard,
  ListOrdered,
  Settings,
  Sparkles
} from 'lucide-react'
import { useApp } from '../store/app'

const items = [
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/environment', label: '环境检测', icon: Activity },
  { to: '/assets', label: '资产管理', icon: FolderKanban },
  { to: '/storyboard', label: '剧本分镜', icon: ListOrdered },
  { to: '/director', label: '导演台', icon: Clapperboard },
  { to: '/queue', label: '生成队列', icon: Film },
  { to: '/settings', label: '设置', icon: Settings }
]

export function Sidebar(): React.JSX.Element {
  const project = useApp((s) => s.project)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-ink-900">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-600 text-white shadow-lg shadow-accent-600/30">
          <Sparkles size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-wide text-white">FrameForge</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Studio</div>
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

      <div className="border-t border-white/5 p-4">
        <div className="rounded-lg bg-ink-850 p-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">当前项目</div>
          <div className="mt-1 truncate text-sm font-medium text-slate-200">
            {project ? project.name : '未打开'}
          </div>
        </div>
      </div>
    </aside>
  )
}
