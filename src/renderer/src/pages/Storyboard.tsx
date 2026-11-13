import { useState } from 'react'
import { Plus, Pencil } from 'lucide-react'
import type { Episode, Scene, Script, Shot } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { ShotStatusBadge } from '../components/badges'
import { ShotEditor, type ShotPatch } from '../components/ShotEditor'
import { persistProject } from '../components/mutate'

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index

export default function Storyboard(): React.JSX.Element {
  const project = useApp((s) => s.project)

  const [newScriptName, setNewScriptName] = useState('')
  const [renamingScriptId, setRenamingScriptId] = useState<string | null>(null)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)

  if (!project) {
    return (
      <div>
        <PageHeader title="剧本分镜" desc="剧本 → 剧集 → 场次 → 分镜，逐级结构化管理" />
        <div className="px-8 pb-8">
          <EmptyState title="请先在仪表盘打开一个项目" />
        </div>
      </div>
    )
  }

  const scripts = [...project.scripts].sort(byIndex)
  const activeScript =
    scripts.find((s) => s.id === project.settings.activeScriptId) ?? scripts[0] ?? null
  const episodes = activeScript
    ? project.episodes.filter((e) => e.scriptId === activeScript.id).sort(byIndex)
    : []
  const selectedShot = selectedShotId
    ? (project.shots.find((s) => s.id === selectedShotId) ?? null)
    : null

  const resetSelection = (): void => {
    setSelectedEpisodeId(null)
    setSelectedSceneId(null)
    setSelectedShotId(null)
  }

  const switchScript = async (id: string): Promise<void> => {
    await persistProject((draft) => {
      draft.settings.activeScriptId = id
    })
    resetSelection()
  }

  const createScript = async (): Promise<void> => {
    const name = newScriptName.trim()
    if (!name) return
    const now = new Date().toISOString()
    await persistProject((draft) => {
      const index = draft.scripts.length ? Math.max(...draft.scripts.map((s) => s.index)) + 1 : 1
      const script: Script = { id: crypto.randomUUID(), index, name, createdAt: now }
      draft.scripts.push(script)
      draft.settings.activeScriptId = script.id
    })
    setNewScriptName('')
    resetSelection()
  }

  const renameScript = async (id: string, name: string): Promise<void> => {
    setRenamingScriptId(null)
    const next = name.trim()
    if (!next) return
    await persistProject((draft) => {
      const script = draft.scripts.find((s) => s.id === id)
      if (script) script.name = next
    })
  }

  const createEpisode = async (): Promise<void> => {
    if (!activeScript) return
    let newId = ''
    await persistProject((draft) => {
      const siblings = draft.episodes.filter((e) => e.scriptId === activeScript.id)
      const index = siblings.length ? Math.max(...siblings.map((e) => e.index)) + 1 : 1
      const episode: Episode = {
        id: crypto.randomUUID(),
        scriptId: activeScript.id,
        index,
        title: `第 ${index} 集`,
        summary: '',
        status: 'idea'
      }
      newId = episode.id
      draft.episodes.push(episode)
    })
    setSelectedEpisodeId(newId)
    setSelectedSceneId(null)
    setSelectedShotId(null)
  }

  const createScene = async (episodeId: string): Promise<void> => {
    let newId = ''
    await persistProject((draft) => {
      const siblings = draft.scenes.filter((s) => s.episodeId === episodeId)
      const index = siblings.length ? Math.max(...siblings.map((s) => s.index)) + 1 : 1
      const scene: Scene = {
        id: crypto.randomUUID(),
        episodeId,
        index,
        title: `场次 ${index}`,
        location: '',
        time: '',
        summary: ''
      }
      newId = scene.id
      draft.scenes.push(scene)
    })
    setSelectedEpisodeId(episodeId)
    setSelectedSceneId(newId)
    setSelectedShotId(null)
  }

  const createShot = async (sceneId: string): Promise<void> => {
    const now = new Date().toISOString()
    let newId = ''
    await persistProject((draft) => {
      const siblings = draft.shots.filter((s) => s.sceneId === sceneId)
      const index = siblings.length ? Math.max(...siblings.map((s) => s.index)) + 1 : 1
      const shot: Shot = {
        id: crypto.randomUUID(),
        sceneId,
        index,
        title: `分镜 ${index}`,
        description: '',
        dialogue: '',
        camera: '',
        duration: 5,
        characterIds: [],
        assetIds: [],
        refImage: null,
        status: 'draft',
        outputs: [],
        createdAt: now,
        updatedAt: now
      }
      newId = shot.id
      draft.shots.push(shot)
    })
    setSelectedShotId(newId)
  }

  const selectEpisode = (id: string): void => {
    setSelectedEpisodeId(id)
    setSelectedSceneId(null)
    setSelectedShotId(null)
  }

  const selectScene = (episodeId: string, sceneId: string): void => {
    setSelectedEpisodeId(episodeId)
    setSelectedSceneId(sceneId)
    setSelectedShotId(null)
  }

  const saveShot = async (patch: ShotPatch): Promise<void> => {
    if (!selectedShot) return
    await persistProject((draft) => {
      const shot = draft.shots.find((s) => s.id === selectedShot.id)
      if (shot) {
        shot.title = patch.title
        shot.description = patch.description
        shot.dialogue = patch.dialogue
        shot.camera = patch.camera
        shot.duration = patch.duration
        shot.assetIds = patch.assetIds
        shot.updatedAt = new Date().toISOString()
      }
    })
  }

  return (
    <div>
      <PageHeader title="剧本分镜" desc="剧本 → 剧集 → 场次 → 分镜，逐级结构化管理" />

      <div className="grid grid-cols-[240px_1fr_360px] items-start gap-4 px-8 pb-8">
        {/* 左：剧本列表 */}
        <div className="panel p-3">
          <div className="px-1 pb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
            剧本
          </div>
          <div className="space-y-1">
            {scripts.map((s) =>
              renamingScriptId === s.id ? (
                <input
                  key={s.id}
                  className="field"
                  defaultValue={s.name}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void renameScript(s.id, e.currentTarget.value)
                    if (e.key === 'Escape') setRenamingScriptId(null)
                  }}
                  onBlur={(e) => void renameScript(s.id, e.currentTarget.value)}
                />
              ) : (
                <div
                  key={s.id}
                  onClick={() => void switchScript(s.id)}
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                    activeScript?.id === s.id
                      ? 'bg-accent-600/15 text-accent-400'
                      : 'text-slate-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <button
                    className="text-slate-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenamingScriptId(s.id)
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              )
            )}
          </div>
          <div className="mt-2 flex gap-1.5 border-t border-white/5 pt-2">
            <input
              className="field"
              placeholder="新剧本名称"
              value={newScriptName}
              onChange={(e) => setNewScriptName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createScript()
              }}
            />
            <button
              className="btn-primary px-2.5"
              disabled={!newScriptName.trim()}
              onClick={() => void createScript()}
              title="新建剧本"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        {/* 中：剧集 / 场次 / 分镜树 */}
        <div className="panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              剧集 / 场次 / 分镜
            </span>
            <button
              className="btn-ghost px-2.5 py-1.5 text-xs"
              disabled={!activeScript}
              onClick={() => void createEpisode()}
            >
              <Plus size={14} />
              新建剧集
            </button>
          </div>

          {episodes.length === 0 ? (
            <EmptyState title="暂无剧集" desc="点击右上角「新建剧集」开始搭建分镜结构" />
          ) : (
            <div className="space-y-1">
              {episodes.map((ep) => {
                const scenes = project.scenes.filter((s) => s.episodeId === ep.id).sort(byIndex)
                const episodeActive = selectedEpisodeId === ep.id
                return (
                  <div key={ep.id}>
                    <div
                      onClick={() => selectEpisode(ep.id)}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                        episodeActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                        {ep.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-slate-500">{scenes.length} 场</span>
                      <button
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-white/[0.06] hover:text-accent-400"
                        onClick={(e) => {
                          e.stopPropagation()
                          void createScene(ep.id)
                        }}
                        title="新建场次"
                      >
                        +场次
                      </button>
                    </div>

                    <div className="ml-4 border-l border-white/5 pl-2">
                      {scenes.map((sc) => {
                        const shots = project.shots.filter((s) => s.sceneId === sc.id).sort(byIndex)
                        const sceneActive = selectedSceneId === sc.id
                        return (
                          <div key={sc.id} className="pt-0.5">
                            <div
                              onClick={() => selectScene(ep.id, sc.id)}
                              className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                                sceneActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate text-sm text-slate-300">
                                {sc.title}
                              </span>
                              <span className="shrink-0 text-[11px] text-slate-500">
                                {shots.length} 镜
                              </span>
                              <button
                                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-white/[0.06] hover:text-accent-400"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void createShot(sc.id)
                                }}
                                title="新建分镜"
                              >
                                +分镜
                              </button>
                            </div>

                            <div className="ml-4 border-l border-white/5 pl-2">
                              {shots.map((sh) => (
                                <button
                                  key={sh.id}
                                  onClick={() => setSelectedShotId(sh.id)}
                                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                                    selectedShotId === sh.id
                                      ? 'bg-accent-600/15'
                                      : 'hover:bg-white/[0.04]'
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate text-sm text-slate-400">
                                    {sh.index}. {sh.title || '未命名分镜'}
                                  </span>
                                  <ShotStatusBadge status={sh.status} />
                                  <span className="shrink-0 text-[11px] text-slate-500">
                                    {sh.outputs.length} 输出
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右：分镜编辑 */}
        <div className="panel p-4">
          {selectedShot ? (
            <ShotEditor
              key={selectedShot.id}
              shot={selectedShot}
              assets={project.assets}
              onSave={(patch) => void saveShot(patch)}
            />
          ) : (
            <EmptyState title="未选择分镜" desc="在中间树里点击一个分镜进行编辑" />
          )}
        </div>
      </div>
    </div>
  )
}
