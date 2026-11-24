import { Pencil } from 'lucide-react'
import type { Asset } from '@shared/types'
import { KindBadge } from './badges'
import { MediaImage } from './MediaImage'

export function AssetCard({
  asset,
  onClick,
  onEdit
}: {
  asset: Asset
  onClick: () => void
  /** 提供时在右上角显示「编辑」按钮（角色卡片点开是大图工作台，编辑走这里） */
  onEdit?: () => void
}): React.JSX.Element {
  const initial = (asset.name || '?').trim().charAt(0).toUpperCase() || '?'
  const versionCount = (asset.images ?? []).length

  return (
    <div className="panel group overflow-hidden text-left transition-colors hover:border-accent/40">
      <button type="button" className="relative block aspect-video w-full overflow-hidden" onClick={onClick}>
        <MediaImage
          src={asset.coverFile}
          alt={asset.name}
          className="h-full w-full object-cover"
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ink-800 to-ink-950">
              <span className="text-4xl font-semibold text-slate-600">{initial}</span>
            </div>
          }
        />
        <div className="absolute left-2 top-2">
          <KindBadge kind={asset.kind} />
        </div>
        {versionCount > 0 && (
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-slate-200">
            {versionCount} 版
          </span>
        )}
        {onEdit && (
          <span
            role="button"
            tabIndex={0}
            title="编辑资产信息"
            className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded bg-black/65 text-slate-200 hover:bg-accent-600 hover:text-white group-hover:flex"
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onEdit()
              }
            }}
          >
            <Pencil size={12} />
          </span>
        )}
      </button>
      <button type="button" className="block w-full p-3 text-left" onClick={onClick}>
        <div className="truncate text-sm font-medium text-white">{asset.name || '未命名资产'}</div>
        {asset.alias && <div className="mt-0.5 truncate text-xs text-slate-500">{asset.alias}</div>}
        {asset.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {asset.tags.slice(0, 4).map((t) => (
              <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-400">
                {t}
              </span>
            ))}
            {asset.tags.length > 4 && (
              <span className="text-[11px] text-slate-600">+{asset.tags.length - 4}</span>
            )}
          </div>
        )}
      </button>
    </div>
  )
}
