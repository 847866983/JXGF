import { useEffect, useState } from 'react'
import { BookText, Image, Layers, Plus } from 'lucide-react'
import type { Asset, AssetKind } from '@shared/types'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { AssetCard } from '../components/AssetCard'
import { AssetForm, type AssetFormData } from '../components/AssetForm'
import { AssetGenerateDialog } from '../components/AssetGenerateDialog'
import { CharacterAssetWizard } from '../components/CharacterAssetWizard'
import { AssetBatchGenerateDialog } from '../components/AssetBatchGenerateDialog'
import { ScriptImportDialog, type ExtractedChar } from '../components/ScriptImportDialog'
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
  const refreshJobs = useApp((s) => s.refreshJobs)
  const openProject = useApp((s) => s.openProject)

  // 后台生成轮询：有任务在跑时每 5 秒刷新一次任务列表和工程数据，
  // 这样在别处提交的生成完成后，资产页能自动出现新图，不用手动重开。
  useEffect(() => {
    if (!project?.id) return
    const timer = window.setInterval(() => {
      void refreshJobs()
      const running = (useApp.getState().jobs ?? []).some(
        (j) => j.status === 'running' || j.status === 'queued'
      )
      if (running) void openProject(project.id)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [project?.id, refreshJobs, openProject])
  const [filter, setFilter] = useState<Filter>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [delMsg, setDelMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [generating, setGenerating] = useState<Asset | null>(null)
  const [wizardAsset, setWizardAsset] = useState<Asset | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [query, setQuery] = useState('')

  if (!project) {
    return (
      <div>
        <PageHeader title="资产管理" desc="角色 / 场景 / 道具的统一资产库，供所有剧本共享" />
      {delMsg && (
        <div className="mx-8 mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{delMsg}</div>
      )}
        <div className="px-8 pb-8">
          <NoProject />
        </div>
      </div>
    )
  }

  const assets = project.assets
  const byKind = filter === 'all' ? assets : assets.filter((a) => a.kind === filter)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? byKind.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q) ||
          (a.prompt ?? '').toLowerCase().includes(q) ||
          (a.alias ?? '').toLowerCase().includes(q) ||
          (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
      )
    : byKind
  const countOf = (f: Filter): number =>
    f === 'all' ? assets.length : assets.filter((a) => a.kind === f).length

  /** 取 store 里的最新资产（避免重开弹窗时用到过期快照） */
  const freshAsset = (id: string): Asset | null =>
    useApp.getState().project?.assets.find((a) => a.id === id) ?? null

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (asset: Asset): void => {
    setEditing(asset)
    setFormOpen(true)
  }

  /** 点卡片：角色 → 角色工作台（大图预览）；其余 → 编辑弹窗 */
  const openAsset = (asset: Asset): void => {
    if (asset.kind === 'character') {
      setWizardAsset(asset)
    } else {
      openEdit(asset)
    }
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

  /** 剧本提取出的角色批量创建为角色资产（已存在同名则跳过，避免重复） */
  const handleImportCharacters = async (chars: ExtractedChar[]): Promise<void> => {
    const now = new Date().toISOString()
    let created = 0
    let skipped = 0
    await persistProject((draft) => {
      const existing = new Set(draft.assets.map((a) => a.name.trim().toLowerCase()))
      for (const c of chars) {
        const name = c.name.trim()
        if (!name || existing.has(name.toLowerCase())) {
          skipped += 1
          continue
        }
        existing.add(name.toLowerCase())
        draft.assets.push({
          id: crypto.randomUUID(),
          name,
          kind: 'character',
          alias: c.alias,
          tags: c.tags,
          description: c.description || c.alias,
          prompt: c.prompt,
          negative: '',
          coverFile: null,
          images: [],
          versions: [],
          createdAt: now,
          updatedAt: now
        })
        created += 1
      }
    })
    setDelMsg(
      `已导入 ${created} 个角色资产${skipped > 0 ? `，跳过 ${skipped} 个同名资产` : ''}。` +
        `点角色卡片进入工作台生成形象图，生成后在分镜提示词里写角色名即可绑定。`
    )
  }

  const handleDelete = async (asset: Asset): Promise<void> => {
    const files = asset.images
    await persistProject((draft) => {
      draft.assets = draft.assets.filter((a) => a.id !== asset.id)
    })
    // 删资产后清理磁盘文件（主进程会检查是否被其它资产/分镜引用）
    for (const f of files) void window.api.mediaDeleteFile(f)
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
    // 清理磁盘文件（主进程以磁盘上的 project.json 为准，扫描全部工程后删除）
    const del = await window.api.mediaDeleteFile(img)
    if (!del.deleted) setDelMsg(`磁盘文件未删除：${del.reason ?? '未知原因'}`)
    else setDelMsg(null)
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
            <button className="btn-ghost" onClick={() => setScriptOpen(true)} title="导入剧本文本，AI 自动提取角色资产">
              <BookText size={15} />
              导入剧本
            </button>
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
        {delMsg && (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-300">
            <span>{delMsg}</span>
            <button className="shrink-0 text-emerald-400/70 hover:text-emerald-200" onClick={() => setDelMsg(null)}>✕</button>
          </div>
        )}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex w-fit items-center gap-1 rounded-lg border border-white/5 bg-ink-900 p-1">
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
          <input
            className="field max-w-[240px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 标签 / 描述…"
          />
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={q ? '没有匹配的资产' : '没有资产'}
            desc={q ? '换个关键词试试' : '点击右上角「新建资产」创建角色 / 场景 / 道具'}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onClick={() => openAsset(asset)}
              />
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
                    const a = editingLive
                    setFormOpen(false) // 关掉编辑弹窗，避免被生成弹窗遮挡
                    if (a.kind === 'character') {
                      setWizardAsset(a) // 角色资产：三步向导
                    } else {
                      setGenerating(a) // 场景 / 道具：沿用旧对话框
                    }
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
            // 生成弹窗关闭后，用最新资产重开编辑弹窗（避免旧快照）
            const fresh = freshAsset(generating.id)
            setGenerating(null)
            if (fresh) {
              setEditing(fresh)
              setFormOpen(true)
            }
          }}
        />
      )}

      {wizardAsset && (
        <CharacterAssetWizard
          asset={wizardAsset}
          onClose={() => {
            // 角色编辑已整合进工作台，关闭即回列表（不再弹旧编辑框）
            setWizardAsset(null)
          }}
        />
      )}

      {batchOpen && <AssetBatchGenerateDialog onClose={() => setBatchOpen(false)} />}

      {scriptOpen && (
        <ScriptImportDialog
          onClose={() => setScriptOpen(false)}
          onImport={(chars) => handleImportCharacters(chars)}
        />
      )}
    </div>
  )
}
