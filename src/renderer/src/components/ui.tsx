import type { ReactNode } from 'react'

export function PageHeader({
  title,
  desc,
  actions
}: {
  title: string
  desc?: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between px-8 pb-6 pt-8">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {desc && <p className="mt-1 text-sm text-slate-400">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default'
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'ok' | 'warn' | 'bad'
}): React.JSX.Element {
  const toneClass = {
    default: 'text-white',
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400'
  }[tone]
  return (
    <div className="panel p-5">
      <div className="text-xs uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

export function EmptyState({ title, desc }: { title: string; desc?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-8 py-16 text-center">
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {desc && <div className="mt-1 max-w-md text-xs text-slate-500">{desc}</div>}
    </div>
  )
}
