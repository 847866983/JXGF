import { useState } from 'react'
import { Image, Layers, Plus } from 'lucide-react'
import type { Asset, AssetKind } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { AssetCard } from '../components/AssetCard'
import { AssetForm, type AssetFormData } from '../components/AssetForm'
import { AssetGenerateDialog } from '../components/AssetGenerateDialog'
import { AssetBatchGenerateDialog } from '../components/AssetBatchGenerateDialog'
import { MediaImage } from '../components/MediaImage'
import { NoProject } from '../components/NoProject'
import { Modal } from '../components/Modal'
import { persistProject } from '../components/mutate'

type Filter = 'all' | AssetKind

const tabs: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'character', label: '角色' },
  { id: 'scene', label: '场景' },
  { id: 'prop', label: '道具' }
]

export default function Assets(): React.JSX.Element {
  const project = useApp((s) => s.project)
  const [filter, setFilter] = useState<Filter>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [generating, setGenerating] = useState<Asset | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)

  if (!project) {
    return (
      <div>
        <PageHeader title="资产管理" desc="角色 / 场景 / 道具的统一资产库，供所有剧本共享" />
        <div className="px-8 pb-8">
          <NoProject />
        </div>
      </div>
    )
  }

  const assets = project.assets
  const filtered = filter === 'all' ? assets : assets.filter((a) => a.kind === filter)
  const countOf = (f: Filter): number =>
    f === 'all' ? assets.length : assets.filter((a) => a.kind === f).length

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (asset: Asset): void => {
    setEditing(asset)
    setFormOpen(true)
  }

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const handleSubmit = async (data: AssetFormData): Promise<void> => {
    if (!data.name) return
    const now = new Date().toISOString()
    await persistProject((draft) => {
      if (editing) {
        const idx = draft.assets.findIndex((a) => a.id === editing.id)
        if (idx >= 0) {
          draft.assets[idx] = { ...draft.assets[idx], ...data, updatedAt: now }
        }
      } else {
        const asset: Asset = {
          id: crypto.randomUUID(),
          ...data,
          coverFile: null,
          images: [],
          versions: [],
          createdAt: now,
          updatedAt: now
        }
        draft.assets.push(asset)
      }
    })
    closeForm()
  }

  const handleDelete = async (asset: Asset): Promise<void> => {
    await persistProject((draft) => {
      draft.assets = draft.assets.filter((a) => a.id !== asset.id)
    })
    closeForm()
  }

  /** 把某张生成图设为绑定图（封面，视频生成时作为参考图传给模型） */
  const handleSetCover = async (assetId: string, img: string): Promise<void> => {
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === assetId)
      if (a) {
        a.coverFile = img
        a.updatedAt = new Date().toISOString()
      }
    })
  }

  /** 删除某张生成图；若删的是绑定图，自动改绑到剩下的第一张 */
  const handleRemoveImage = async (assetId: string, img: string): Promise<void> => {
    await persistProject((draft) => {
      const a = draft.assets.find((x) => x.id === assetId)
      if (!a) return
      a.images = a.images.filter((x) => x !== img)
      if (a.coverFile === img) a.coverFile = a.images[0] ?? null
      a.updatedAt = new Date().toISOString()
    })
  }

  // 始终用最新项目数据里的资产（生成/改绑定后能实时反映）
  const editingLive = editing ? (project.assets.find((a) => a.id === editing.id) ?? editing) : null

  return (
    <div>
      <PageHeader
        title="资产管理"
        desc="角色 / 场景 / 道具的统一资产库，供所有剧本共享"
        crumbs={[project.name, '资产管理']}
        actions={
          <>
            <button className="btn-ghost" onClick={() => setBatchOpen(true)}>
              <Layers size={15} />
              一键生成
            </button>
            <button className="btn-primary" onClick={openCreate}>
              <Plus size={15} />
              新建资产
            </button>
          </>
        }
      />

      <div className="px-8 pb-8">
        <div className="mb-4 flex w-fit items-center gap-1 rounded-lg border border-white/5 bg-ink-900 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setFilter(t.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                filter === t.id ? 'bg-accent-600/20 text-accent-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-slate-500">{countOf(t.id)}</span>
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="没有资产" desc="点击右上角「新建资产」创建角色 / 场景 / 道具" />
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onClick={() => openEdit(asset)} />
            ))}
          </div>
        )}
      </div>

      {formOpen && (
        <Modal
          title={editing ? '编辑资产' : '新建资产'}
          onClose={closeForm}
          footer={
            <>
              {editing && (
                <button
                  className="btn-ghost text-rose-300 hover:bg-rose-500/10"
                  onClick={() => void handleDelete(editing)}
                >
                  删除
                </button>
              )}
              {editingLive && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setGenerating(editingLive)
                    setFormOpen(false) // 关掉编辑弹窗，避免被生成弹窗遮挡
                  }}
                >
                  <Image size={15} />
                  生成 / 再生成图
                </button>
              )}
              <button className="btn-ghost" onClick={closeForm}>
                取消
              </button>
              <button className="btn-primary" type="submit" form="asset-form">
                保存
              </button>
            </>
          }
        >
          {editingLive && editingLive.images.length > 0 && (
            <div className="mb-5">
              <label className="label">生成图（点图设为绑定图，视频生成时用它当参考）</label>
              <div className="grid grid-cols-4 gap-2">
                {editingLive.images.map((img) => {
                  const bound = editingLive.coverFile === img
                  return (
                    <div
                      key={img}
                      className={`group relative aspect-square overflow-hidden rounded-lg border ${
                        bound ? 'border-accent-500 ring-1 ring-accent-500' : 'border-white/10'
                      }`}
                    >
                      <button
                        type="button"
                        className="h-full w-full"
                        onClick={() => void handleSetCover(editingLive.id, img)}
                        title={bound ? '当前绑定图' : '点此设为绑定图'}
                      >
                        <MediaImage
                          src={img}
                          alt=""
                          className="h-full w-full object-cover"
                          fallback={<div className="h-full w-full bg-ink-850" />}
                        />
                      </button>
                      {bound && (
                        <span className="pointer-events-none absolute left-1 top-1 rounded bg-accent-600 px-1.5 py-0.5 text-[10px] text-white">
                          绑定
                        </span>
                      )}
                      <button
                        type="button"
                        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-black/60 text-xs text-white group-hover:flex hover:bg-rose-600"
                        title="删除这张"
                        onClick={() => void handleRemoveImage(editingLive.id, img)}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <AssetForm initial={editing} submitId="asset-form" onSubmit={(d) => void handleSubmit(d)} />
        </Modal>
      )}

      {generating && (
        <AssetGenerateDialog
          asset={generating}
          onClose={() => {
            // 生成弹窗关闭后，重新打开该资产的编辑弹窗，方便看新生成的图
            const a = generating
            setGenerating(null)
            setEditing(a)
            setFormOpen(true)
          }}
        />
      )}

      {batchOpen && <AssetBatchGenerateDialog onClose={() => setBatchOpen(false)} />}
    </div>
  )
}
