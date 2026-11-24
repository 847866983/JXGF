import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export function PageHeader({
  title,
  desc,
  actions,
  crumbs
}: {
  title: string
  desc?: string
  actions?: ReactNode
  crumbs?: string[]
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between px-8 pb-6 pt-8">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <div className="mb-1 flex items-center gap-1 text-[11px] text-slate-600">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-slate-700">›</span>}
                <span className={i === crumbs.length - 1 ? 'text-slate-400' : ''}>{c}</span>
              </span>
            ))}
          </div>
        )}
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {desc && <p className="mt-1 text-sm text-slate-400">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'ok' | 'warn' | 'bad'
  icon?: ReactNode
}): React.JSX.Element {
  const toneClass = {
    default: 'text-white',
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400'
  }[tone]
  return (
    <div className="panel group p-5 transition-colors hover:border-white/15">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-widest text-slate-500">{label}</div>
        {icon && <span className="text-slate-600 transition-colors group-hover:text-accent-400">{icon}</span>}
      </div>
      <div className={`mt-2 text-xl font-semibold leading-tight ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 truncate text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

export function EmptyState({
  title,
  desc,
  icon,
  action,
  compact
}: {
  title: string
  desc?: string
  icon?: ReactNode
  action?: ReactNode
  /** 紧凑模式：内边距与图标更小，适合嵌在时间轴/面板内部 */
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.01] text-center ${
        compact ? 'px-6 py-6' : 'px-8 py-14'
      }`}
    >
      <div
        className={`mb-3 flex items-center justify-center rounded-2xl bg-white/[0.04] text-slate-500 ${
          compact ? 'h-8 w-8' : 'h-12 w-12'
        }`}
      >
        {icon ?? <Inbox size={compact ? 16 : 22} />}
      </div>
      <div className={`font-medium text-slate-300 ${compact ? 'text-xs' : 'text-sm'}`}>{title}</div>
      {desc && <div className={`mt-1 max-w-md text-slate-500 ${compact ? 'text-[11px]' : 'text-xs'}`}>{desc}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
