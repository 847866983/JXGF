import { useState } from 'react'
import type { Asset, AssetKind, Shot } from '@shared/types'
import { KindBadge, ShotStatusBadge } from './badges'

export interface ShotPatch {
  title: string
  description: string
  dialogue: string
  camera: string
  duration: number
  prompt: string
  assetIds: string[]
  characterNotes: Record<string, string>
}

const groups: { kind: AssetKind; label: string }[] = [
  { kind: 'character', label: '角色' },
  { kind: 'scene', label: '场景' },
  { kind: 'prop', label: '道具' }
]

export function ShotEditor({
  shot,
  assets,
  onSave
}: {
  shot: Shot
  assets: Asset[]
  onSave: (patch: ShotPatch) => void
}): React.JSX.Element {
  const [title, setTitle] = useState(shot.title)
  const [description, setDescription] = useState(shot.description)
  const [dialogue, setDialogue] = useState(shot.dialogue)
  const [camera, setCamera] = useState(shot.camera)
  const [duration, setDuration] = useState<number>(shot.duration)
  const [prompt, setPrompt] = useState(shot.prompt || shot.description || '')
  const [assetIds, setAssetIds] = useState<string[]>(shot.assetIds)
  const [characterNotes, setCharacterNotes] = useState<Record<string, string>>(shot.characterNotes ?? {})

  const toggleAsset = (id: string): void => {
    setAssetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = (): void => {
    // 只保留已引用资产的动作说明
    const notes: Record<string, string> = {}
    for (const id of assetIds) {
      const v = (characterNotes[id] ?? '').trim()
      if (v) notes[id] = v
    }
    onSave({
      title: title.trim(),
      description,
      dialogue,
      camera: camera.trim(),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 5,
      prompt: prompt.trim(),
      assetIds,
      characterNotes: notes
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white">分镜 {shot.index}</span>
        <ShotStatusBadge status={shot.status} />
        <span className="text-[11px] text-slate-500">{shot.outputs.length} 个产物</span>
      </div>

      <div>
        <label className="label">标题</label>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div>
        <label className="label">画面描述</label>
        <textarea
          className="field min-h-[120px] resize-y leading-relaxed"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div>
        <label className="label">视频提示词（详细，用于生成）</label>
        <textarea
          className="field min-h-[200px] resize-y leading-relaxed"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="详细描述要生成的视频画面：主体、动作、镜头、光影、风格等，用于 H3 视频生成"
        />
        <div className="mt-1 text-[11px] text-slate-600">
          与「画面描述」独立，这里写详细视频提示词；留空则回退用画面描述。
        </div>
      </div>

      <div>
        <label className="label">台词</label>
        <textarea
          className="field min-h-[48px] resize-y"
          value={dialogue}
          onChange={(e) => setDialogue(e.target.value)}
        />
      </div>

      <div>
        <label className="label">运镜</label>
        <input className="field" value={camera} onChange={(e) => setCamera(e.target.value)} />
      </div>

      <div>
        <label className="label">时长（秒）</label>
        <input
          type="number"
          min={1}
          className="field"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </div>

      <div>
        <label className="label">引用资产</label>
        <div className="space-y-2">
          {groups.map((g) => {
            const items = assets.filter((a) => a.kind === g.kind)
            if (items.length === 0) return null
            return (
              <div key={g.kind}>
                <div className="mb-1 flex items-center gap-2">
                  <KindBadge kind={g.kind} />
                  <span className="text-xs text-slate-500">{g.label}</span>
                </div>
                <div className="space-y-1">
                  {items.map((a) => {
                    const checked = assetIds.includes(a.id)
                    return (
                      <div key={a.id} className="rounded px-1.5 py-1 hover:bg-white/[0.04]">
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            className="accent-[#7c5cff]"
                            checked={checked}
                            onChange={() => toggleAsset(a.id)}
                          />
                          <span className="truncate">{a.name}</span>
                        </label>
                        {checked && (
                          <input
                            className="field mt-1 !py-1 text-xs"
                            placeholder={
                              g.kind === 'character'
                                ? '本镜位置/动作，如：左侧前景，正低头系鞋带'
                                : '本镜中的位置/状态（可选）'
                            }
                            value={characterNotes[a.id] ?? ''}
                            onChange={(e) =>
                              setCharacterNotes((prev) => ({ ...prev, [a.id]: e.target.value }))
                            }
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {assets.length === 0 && (
            <div className="text-xs text-slate-500">暂无资产，去「资产管理」创建</div>
          )}
        </div>
      </div>

      <button className="btn-primary w-full" onClick={submit}>
        保存分镜
      </button>
    </div>
  )
}
