import { useState } from 'react'
import { Plus, Pencil } from 'lucide-react'
import type { Episode, Scene, Script, Shot } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { NoProject } from '../components/NoProject'
import { ShotStatusBadge } from '../components/badges'
import { ShotEditor, type ShotPatch } from '../components/ShotEditor'
import { Modal } from '../components/Modal'
import { persistProject } from '../components/mutate'

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index

export default function Storyboard(): React.JSX.Element {
  const project = useApp((s) => s.project)

  const [newScriptName, setNewScriptName] = useState('')
  const [renamingScriptId, setRenamingScriptId] = useState<string | null>(null)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [editingShotId, setEditingShotId] = useState<string | null>(null)

  if (!project) {
    return (
      <div>
        <PageHeader title="剧本分镜" desc="剧本 → 剧集 → 场次 → 分镜" />
        <div className="px-8 pb-8">
          <NoProject />
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

  // 当前选中的场次（默认第一集第一场）
  const selectedEpisode = episodes.find((e) => e.id === selectedEpisodeId) ?? episodes[0] ?? null
  const scenes = selectedEpisode
    ? project.scenes.filter((s) => s.episodeId === selectedEpisode.id).sort(byIndex)
    : []
  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? scenes[0] ?? null
  const shots = selectedScene
    ? project.shots.filter((s) => s.sceneId === selectedScene.id).sort(byIndex)
    : []

  const editingShot = editingShotId
    ? (project.shots.find((s) => s.id === editingShotId) ?? null)
    : null

  const resetSelection = (): void => {
    setSelectedEpisodeId(null)
    setSelectedSceneId(null)
    setEditingShotId(null)
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
    setEditingShotId(null)
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
    setEditingShotId(null)
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
        prompt: '',
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
    setEditingShotId(newId)
  }

  const selectEpisode = (id: string): void => {
    setSelectedEpisodeId(id)
    setSelectedSceneId(null)
    setEditingShotId(null)
  }

  const selectScene = (episodeId: string, sceneId: string): void => {
    setSelectedEpisodeId(episodeId)
    setSelectedSceneId(sceneId)
    setEditingShotId(null)
  }

  const saveShot = async (patch: ShotPatch): Promise<void> => {
    if (!editingShot) return
    await persistProject((draft) => {
      const shot = draft.shots.find((s) => s.id === editingShot.id)
      if (shot) {
        shot.title = patch.title
        shot.description = patch.description
        shot.dialogue = patch.dialogue
        shot.camera = patch.camera
        shot.duration = patch.duration
        shot.prompt = patch.prompt
        shot.assetIds = patch.assetIds
        shot.characterNotes = patch.characterNotes
        shot.updatedAt = new Date().toISOString()
      }
    })
    setEditingShotId(null)
  }

  const deleteShot = async (): Promise<void> => {
    if (!editingShot) return
    await persistProject((draft) => {
      draft.shots = draft.shots.filter((s) => s.id !== editingShot.id)
    })
    setEditingShotId(null)
  }

  return (
    <div>
      <PageHeader
        title="剧本分镜"
        desc="剧本 → 剧集 → 场次 → 分镜"
        crumbs={[
          project.name,
          activeScript?.name ?? '剧本',
          selectedEpisode?.title ?? '',
          selectedScene?.title ?? ''
        ].filter(Boolean)}
      />

      <div className="px-8 pb-8">
        {/* 顶部：剧本切换条 */}
        <div className="panel mb-4 p-3">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-semibold uppercase tracking-widest text-slate-500">
              剧本
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {scripts.map((s) =>
                renamingScriptId === s.id ? (
                  <input
                    key={s.id}
                    className="field w-40 py-1"
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
                    className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      activeScript?.id === s.id
                        ? 'bg-accent-600/20 text-accent-400'
                        : 'text-slate-300 hover:bg-white/[0.05]'
                    }`}
                  >
                    <span className="truncate">{s.name}</span>
                    <button
                      className="text-slate-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingScriptId(s.id)
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                )
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <input
                className="field w-36 py-1"
                placeholder="新剧本名称"
                value={newScriptName}
                onChange={(e) => setNewScriptName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createScript()
                }}
              />
              <button
                className="btn-primary px-2.5 py-1.5"
                disabled={!newScriptName.trim()}
                onClick={() => void createScript()}
                title="新建剧本"
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        </div>

        {/* 下方：左树 + 右分镜列表 */}
        <div className="grid grid-cols-[300px_1fr] items-start gap-4">
          {/* 左：剧集 → 场次 树 */}
          <div className="panel p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                剧集 / 场次
              </span>
              <button
                className="btn-ghost px-2 py-1 text-xs"
                disabled={!activeScript}
                onClick={() => void createEpisode()}
              >
                <Plus size={13} />
                剧集
              </button>
            </div>

            {episodes.length === 0 ? (
              <EmptyState title="暂无剧集" desc="点「剧集」新建第一集" />
            ) : (
              <div className="space-y-1">
                {episodes.map((ep) => {
                  const epScenes = project.scenes.filter((s) => s.episodeId === ep.id).sort(byIndex)
                  const epActive = selectedEpisode?.id === ep.id
                  return (
                    <div key={ep.id}>
                      <div
                        onClick={() => selectEpisode(ep.id)}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                          epActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                          {ep.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-500">{epScenes.length} 场</span>
                        <button
                          className="shrink-0 rounded px-1 py-0.5 text-xs text-slate-500 hover:bg-white/[0.06] hover:text-accent-400"
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
                        {epScenes.map((sc) => {
                          const scShots = project.shots.filter((s) => s.sceneId === sc.id)
                          const scActive = selectedScene?.id === sc.id
                          return (
                            <div
                              key={sc.id}
                              onClick={() => selectScene(ep.id, sc.id)}
                              className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                                scActive ? 'bg-accent-600/15 text-accent-400' : 'hover:bg-white/[0.04]'
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate text-sm">{sc.title}</span>
                              <span className="shrink-0 text-[11px] text-slate-500">{scShots.length} 镜</span>
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

          {/* 右：分镜列表 */}
          <div className="panel p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                分镜{selectedScene ? ` · ${selectedScene.title}` : ''}
              </span>
              {selectedScene && (
                <button
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => void createShot(selectedScene.id)}
                >
                  <Plus size={13} />
                  分镜
                </button>
              )}
            </div>

            {!selectedScene ? (
              <EmptyState title="请选择一个场次" desc="在左侧树里点击场次查看其分镜" />
            ) : shots.length === 0 ? (
              <EmptyState title="该场次还没有分镜" desc="点「分镜」新建" />
            ) : (
              <div className="space-y-2">
                {shots.map((sh) => (
                  <div
                    key={sh.id}
                    onClick={() => setEditingShotId(sh.id)}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-accent/40 hover:bg-white/[0.04]"
                  >
                    <span className="w-8 shrink-0 text-center text-sm font-semibold text-slate-400">
                      {sh.index}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-white">
                          {sh.title || '未命名分镜'}
                        </span>
                        <ShotStatusBadge status={sh.status} />
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                        {sh.prompt || sh.description || '暂无提示词'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[11px] text-slate-500">{sh.duration}s</div>
                      <div className="text-[11px] text-slate-600">{sh.outputs.length} 输出</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 分镜编辑弹窗 */}
      {editingShot && (
        <Modal
          title={`分镜 ${editingShot.index} · ${editingShot.title || '未命名'}`}
          onClose={() => setEditingShotId(null)}
          footer={
            <>
              <button className="btn-ghost text-rose-300 hover:bg-rose-500/10" onClick={() => void deleteShot()}>
                删除
              </button>
              <button className="btn-ghost" onClick={() => setEditingShotId(null)}>
                关闭
              </button>
            </>
          }
        >
          <ShotEditor
            key={editingShot.id}
            shot={editingShot}
            assets={project.assets}
            onSave={(patch) => void saveShot(patch)}
          />
        </Modal>
      )}
    </div>
  )
}
