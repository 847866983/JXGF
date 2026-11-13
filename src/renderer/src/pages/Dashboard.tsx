import { useEffect, useState } from 'react'
import { Cpu, FolderPlus, Gauge, HardDrive, RefreshCw } from 'lucide-react'
import type { ProjectSummary } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader, StatCard } from '../components/ui'

export default function Dashboard(): React.JSX.Element {
  const hardware = useApp((s) => s.hardware)
  const comfy = useApp((s) => s.comfy)
  const loadHardware = useApp((s) => s.loadHardware)
  const refreshComfy = useApp((s) => s.refreshComfy)
  const openProject = useApp((s) => s.openProject)
  const createProject = useApp((s) => s.createProject)

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [newName, setNewName] = useState('')

  const loadProjects = (): void => {
    void window.api.projectList().then(setProjects)
  }

  useEffect(() => {
    void loadHardware()
    void refreshComfy()
    loadProjects()
    const t = setInterval(() => void refreshComfy(), 6000)
    return () => clearInterval(t)
  }, [loadHardware, refreshComfy])

  const gpu = hardware?.gpu
  const vram = gpu?.vramKnown ? `${(gpu.vramMB / 1024).toFixed(0)} GB` : '未知'

  return (
    <div>
      <PageHeader
        title="仪表盘"
        desc="本机硬件能力、ComfyUI 状态与项目总览"
        actions={
          <button className="btn-ghost" onClick={() => void loadHardware()}>
            <RefreshCw size={15} />
            重新检测
          </button>
        }
      />

      <div className="grid grid-cols-4 gap-4 px-8">
        <StatCard
          label="显卡"
          value={gpu?.name ?? '检测中…'}
          hint={gpu ? `${gpu.driver || '驱动未知'}` : '正在读取硬件信息'}
          tone={gpu?.vendor === 'nvidia' ? 'ok' : 'warn'}
        />
        <StatCard
          label="显存"
          value={vram}
          hint={hardware ? hardware.preset.label : undefined}
          tone={gpu?.vendor === 'nvidia' && gpu.vramMB >= 6144 ? 'ok' : 'warn'}
        />
        <StatCard
          label="生成档位"
          value={hardware?.preset.label ?? '—'}
          hint={
            hardware
              ? `${hardware.preset.video.width}×${hardware.preset.video.height} @ ${hardware.preset.video.frames} 帧`
              : undefined
          }
        />
        <StatCard
          label="ComfyUI"
          value={comfy?.online ? '已连接' : '未连接'}
          hint={comfy?.online ? `v${comfy.version}` : '请确认已启动并配置地址'}
          tone={comfy?.online ? 'ok' : 'bad'}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4 px-8">
        <div className="panel col-span-2 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
            <Gauge size={15} className="text-accent-400" />
            硬件建议
          </div>
          {hardware?.recommendations.length ? (
            <ul className="space-y-2">
              {hardware.recommendations.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-slate-500">检测中…</div>
          )}
        </div>

        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
            <HardDrive size={15} className="text-accent-400" />
            运行环境
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">模式</span>
              <span className="text-slate-200">
                {hardware?.comfyMode === 'local-full'
                  ? '本地全功能'
                  : hardware?.comfyMode === 'local-image'
                    ? '本地图片'
                    : '远程'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">队列</span>
              <span className="text-slate-200">
                {comfy ? `${comfy.queueRunning} 运行 / ${comfy.queueRemaining} 等待` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="mb-3 mt-6 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">项目</h2>
          <div className="flex items-center gap-2">
            <input
              className="field w-56"
              placeholder="新项目名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  void createProject(newName.trim()).then(() => {
                    setNewName('')
                    loadProjects()
                  })
                }
              }}
            />
            <button
              className="btn-primary"
              disabled={!newName.trim()}
              onClick={() =>
                void createProject(newName.trim()).then(() => {
                  setNewName('')
                  loadProjects()
                })
              }
            >
              <FolderPlus size={15} />
              新建
            </button>
          </div>
        </div>

        {projects.length === 0 ? (
          <EmptyState title="还没有项目" desc="点击右上角「新建」创建你的第一个视频项目" />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {projects.map((p) => (
              <button
                key={p.id}
                className="panel p-4 text-left transition-colors hover:border-accent/40"
                onClick={() => void openProject(p.id)}
              >
                <div className="flex items-center gap-2">
                  <Cpu size={14} className="text-accent-400" />
                  <span className="truncate font-medium text-white">{p.name}</span>
                </div>
                <div className="mt-3 flex gap-4 text-xs text-slate-500">
                  <span>{p.scriptCount} 剧本</span>
                  <span>{p.shotCount} 分镜</span>
                  <span>{p.assetCount} 资产</span>
                </div>
                <div className="mt-2 text-[11px] text-slate-600">
                  更新于 {new Date(p.updatedAt).toLocaleString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
