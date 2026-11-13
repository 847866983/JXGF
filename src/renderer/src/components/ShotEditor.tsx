import { useState } from 'react'
import type { Asset, AssetKind, Shot } from '@shared/types'
import { KindBadge, ShotStatusBadge } from './badges'

export interface ShotPatch {
  title: string
  description: string
  dialogue: string
  camera: string
  duration: number
  assetIds: string[]
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
  const [assetIds, setAssetIds] = useState<string[]>(shot.assetIds)

  const toggleAsset = (id: string): void => {
    setAssetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = (): void => {
    onSave({
      title: title.trim(),
      description,
      dialogue,
      camera: camera.trim(),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 5,
      assetIds
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
          className="field min-h-[72px] resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
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
                <div className="space-y-0.5">
                  {items.map((a) => (
                    <label
                      key={a.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-slate-300 hover:bg-white/[0.04]"
                    >
                      <input
                        type="checkbox"
                        className="accent-[#7c5cff]"
                        checked={assetIds.includes(a.id)}
                        onChange={() => toggleAsset(a.id)}
                      />
                      <span className="truncate">{a.name}</span>
                    </label>
                  ))}
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
