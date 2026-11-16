import type { Asset } from '@shared/types'
import { KindBadge } from './badges'
import { MediaImage } from './MediaImage'

export function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }): React.JSX.Element {
  const initial = (asset.name || '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <button
      className="panel overflow-hidden text-left transition-colors hover:border-accent/40"
      onClick={onClick}
    >
      <div className="relative aspect-video w-full overflow-hidden">
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
      </div>
      <div className="p-3">
        <div className="truncate text-sm font-medium text-white">{asset.name || '未命名资产'}</div>
        {asset.alias && <div className="mt-0.5 truncate text-xs text-slate-500">{asset.alias}</div>}
        {asset.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {asset.tags.slice(0, 4).map((t) => (
              <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                {t}
              </span>
            ))}
            {asset.tags.length > 4 && (
              <span className="text-[10px] text-slate-600">+{asset.tags.length - 4}</span>
            )}
          </div>
        )}
      </div>
    </button>
  )
}
