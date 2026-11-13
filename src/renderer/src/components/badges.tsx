import type { AssetKind, ShotStatus } from '@shared/types'

export const kindLabel: Record<AssetKind, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具'
}

const kindTone: Record<AssetKind, string> = {
  character: 'bg-accent-600/15 text-accent-400',
  scene: 'bg-emerald-500/10 text-emerald-400',
  prop: 'bg-amber-500/10 text-amber-400'
}

export function KindBadge({ kind }: { kind: AssetKind }): React.JSX.Element {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${kindTone[kind]}`}>{kindLabel[kind]}</span>
}

export const shotStatusLabel: Record<ShotStatus, string> = {
  draft: '草稿',
  ready: '就绪',
  generating: '生成中',
  done: '完成',
  failed: '失败'
}

const shotStatusTone: Record<ShotStatus, string> = {
  draft: 'bg-white/5 text-slate-400',
  ready: 'bg-accent-600/15 text-accent-400',
  generating: 'bg-amber-500/10 text-amber-400',
  done: 'bg-emerald-500/10 text-emerald-400',
  failed: 'bg-rose-500/10 text-rose-400'
}

export function ShotStatusBadge({ status }: { status: ShotStatus }): React.JSX.Element {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${shotStatusTone[status]}`}>
      {shotStatusLabel[status]}
    </span>
  )
}
