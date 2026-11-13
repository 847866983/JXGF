import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { Asset, AssetKind } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { AssetCard } from '../components/AssetCard'
import { AssetForm, type AssetFormData } from '../components/AssetForm'
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

  if (!project) {
    return (
      <div>
        <PageHeader title="资产管理" desc="角色 / 场景 / 道具的统一资产库，供所有剧本共享" />
        <div className="px-8 pb-8">
          <EmptyState title="请先在仪表盘打开一个项目" />
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

  return (
    <div>
      <PageHeader
        title="资产管理"
        desc="角色 / 场景 / 道具的统一资产库，供所有剧本共享"
        actions={
          <button className="btn-primary" onClick={openCreate}>
            <Plus size={15} />
            新建资产
          </button>
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
              <button className="btn-ghost" onClick={closeForm}>
                取消
              </button>
              <button className="btn-primary" type="submit" form="asset-form">
                保存
              </button>
            </>
          }
        >
          <AssetForm initial={editing} submitId="asset-form" onSubmit={(d) => void handleSubmit(d)} />
        </Modal>
      )}
    </div>
  )
}
