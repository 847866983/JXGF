import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Film, Play, Wand2 } from 'lucide-react'
import type { Shot } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { ShotStatusBadge } from '../components/badges'

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index

function renderable(src: string | null): boolean {
  return Boolean(src && /^(https?:|file:|data:)/.test(src))
}

export default function Director(): React.JSX.Element {
  const project = useApp((s) => s.project)
  const hardware = useApp((s) => s.hardware)
  const navigate = useNavigate()

  const [episodeId, setEpisodeId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [submittingShotId, setSubmittingShotId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)

  if (!project) {
    return (
      <div>
        <PageHeader title="导演台" desc="按集编排镜头时间线，引用角色资产并提交生成" />
        <div className="px-8 pb-8">
          <EmptyState title="请先在仪表盘打开一个项目" />
        </div>
      </div>
    )
  }

  if (project.episodes.length === 0) {
    return (
      <div>
        <PageHeader title="导演台" desc="按集编排镜头时间线，引用角色资产并提交生成" />
        <div className="px-8 pb-8">
          <EmptyState title="还没有剧集" desc="先去「剧本分镜」创建剧集、场次与分镜" />
        </div>
      </div>
    )
  }

  const episodes = [...project.episodes].sort(byIndex)
  const selectedEpisode = episodes.find((e) => e.id === episodeId) ?? episodes[0]

  const scenes = project.scenes.filter((s) => s.episodeId === selectedEpisode.id).sort(byIndex)
  const sceneById = new Map(scenes.map((s) => [s.id, s]))
  const shots = project.shots
    .filter((sh) => sceneById.has(sh.sceneId))
    .sort((a, b) => {
      const sa = sceneById.get(a.sceneId)
      const sb = sceneById.get(b.sceneId)
      if (!sa || !sb) return 0
      return sa.index - sb.index || a.index - b.index
    })

  const template =
    project.templates.find((t) => t.id === templateId) ?? project.templates[0] ?? null
  const preset = hardware?.preset.video ?? null
  const canGenerate = Boolean(template && preset)
  const pendingCount = shots.filter((s) => s.outputs.length === 0).length

  const generateHint = (): string | undefined => {
    if (!template) return '项目还没有工作流模板，先在设置里导入'
    if (!preset) return '尚未检测到硬件档位，无法确定生成参数'
    return undefined
  }

  const submitJob = async (shot: Shot): Promise<void> => {
    if (!template || !preset) return
    // 收集分镜引用资产的封面图作为视频参考图（H3 ref2va 素材）
    const refImages = shot.assetIds
      .map((id) => project.assets.find((a) => a.id === id)?.coverFile)
      .filter((f): f is string => Boolean(f))
    await window.api.jobGenerate({
      projectId: project.id,
      shotId: shot.id,
      templateId: template.id,
      positive: shot.description || shot.title,
      width: preset.width,
      height: preset.height,
      frames: preset.frames,
      refImages: refImages.length > 0 ? refImages : undefined
    })
  }

  const generateOne = async (shot: Shot): Promise<void> => {
    setSubmittingShotId(shot.id)
    try {
      await submitJob(shot)
      navigate('/queue')
    } finally {
      setSubmittingShotId(null)
    }
  }

  const generateAll = async (): Promise<void> => {
    if (!canGenerate || batchRunning) return
    setBatchRunning(true)
    try {
      for (const shot of shots) {
        if (shot.outputs.length > 0) continue
        setSubmittingShotId(shot.id)
        await submitJob(shot)
      }
      navigate('/queue')
    } finally {
      setSubmittingShotId(null)
      setBatchRunning(false)
    }
  }

  const assetName = (id: string): string => project.assets.find((a) => a.id === id)?.name ?? id

  return (
    <div>
      <PageHeader title="导演台" desc="按集编排镜头时间线，引用角色资产并提交生成" />

      <div className="px-8 pb-8">
        <div className="mb-4 flex items-center gap-3">
          <select
            className="field w-80"
            value={selectedEpisode.id}
            onChange={(e) => setEpisodeId(e.target.value)}
          >
            {episodes.map((ep) => {
              const script = project.scripts.find((s) => s.id === ep.scriptId)
              return (
                <option key={ep.id} value={ep.id}>
                  {script ? `${script.name} · ` : ''}
                  {ep.title}
                </option>
              )
            })}
          </select>
          <span className="text-xs text-slate-500">
            {shots.length} 个分镜 · {pendingCount} 个待生成
          </span>
          {project.templates.length > 1 && (
            <select
              className="field w-56"
              value={template?.id ?? ''}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {project.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'video' ? '视频 · ' : '图片 · '}
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto">
            <button
              className="btn-ghost"
              disabled={!canGenerate || batchRunning || pendingCount === 0}
              onClick={() => void generateAll()}
            >
              <Play size={15} />
              {batchRunning ? '提交中…' : `连续生成（${pendingCount}）`}
            </button>
          </div>
        </div>

        {!canGenerate && (
          <div className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
            {generateHint()}
          </div>
        )}

        {shots.length === 0 ? (
          <EmptyState title="该剧集下还没有分镜" desc="先去「剧本分镜」为场次添加镜头" />
        ) : (
          <div className="space-y-3">
            {shots.map((shot) => {
              const scene = sceneById.get(shot.sceneId)
              const characters = shot.characterIds.map(assetName)
              return (
                <div key={shot.id} className="panel flex items-center gap-4 p-4">
                  <div className="h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-white/5 bg-ink-800">
                    {renderable(shot.refImage) ? (
                      <img
                        src={shot.refImage as string}
                        alt={shot.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-600">
                        <Film size={22} />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">
                        {scene ? `S${scene.index}.` : ''}
                        {shot.index} {shot.title || '未命名分镜'}
                      </span>
                      <ShotStatusBadge status={shot.status} />
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {shot.duration}s · {shot.outputs.length} 输出
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {shot.description || '暂无画面描述'}
                    </div>
                    {characters.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {characters.map((name) => (
                          <span
                            key={name}
                            className="rounded bg-accent-600/15 px-1.5 py-0.5 text-[11px] text-accent-400"
                          >
                            {name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    className="btn-primary shrink-0"
                    disabled={!canGenerate || submittingShotId === shot.id || batchRunning}
                    title={generateHint()}
                    onClick={() => void generateOne(shot)}
                  >
                    <Wand2 size={14} />
                    {submittingShotId === shot.id ? '提交中…' : '生成'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
