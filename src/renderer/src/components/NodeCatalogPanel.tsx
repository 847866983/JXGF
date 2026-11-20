import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, Cpu, FileUp, Layers3 } from 'lucide-react'
import { NODE_DOMAINS, STATUS_LABEL, type NodeCapabilityStatus } from '@shared/node-catalog'

/**
 * 节点能力总览 —— 班长全家桶 9 大功能域的可发现性入口。
 * 每个节点标注「软件内可调 / 后端自动 / 导入模板」以及在哪一步使用，
 * 让用户按需取舍，不必打开 ComfyUI 网页端也能知道软件覆盖了什么。
 */

const STATUS_STYLE: Record<NodeCapabilityStatus, string> = {
  ui: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  backend: 'border-slate-500/30 bg-white/[0.03] text-slate-400',
  template: 'border-sky-500/30 bg-sky-500/10 text-sky-300'
}

const DOMAIN_ICON = {
  clapperboard: '🎬',
  maximize: '⤢',
  'fast-forward': '⏩',
  cpu: '🧠',
  gauge: '🎛️',
  film: '🎞️',
  music: '🎵',
  image: '🖼️'
} as const

export function NodeCatalogPanel(): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set(['csglide', 'upscale']))

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="panel p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-white">
        <Layers3 size={15} className="text-accent-400" />
        节点能力总览（班长全家桶）
      </div>
      <div className="mb-4 text-xs text-slate-500">
        节点包共 9 大功能域、约 100 个节点。下面标注每一项在镜序工坊里的覆盖方式：
        <span className="mx-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 text-emerald-300">软件内可调</span>
        <span className="mx-1 rounded border border-slate-500/30 bg-white/[0.03] px-1 text-slate-400">后端自动</span>
        <span className="mx-1 rounded border border-sky-500/30 bg-sky-500/10 px-1 text-sky-300">导入模板</span>
        —— 推理计算留在 ComfyUI 后端，软件负责参数编排与界面。
      </div>

      <div className="space-y-2">
        {NODE_DOMAINS.map((d) => {
          const isOpen = open.has(d.id)
          return (
            <section key={d.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => toggle(d.id)}>
                {isOpen ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                <span>{DOMAIN_ICON[d.icon as keyof typeof DOMAIN_ICON] ?? '•'}</span>
                <span className="text-xs font-medium text-slate-200">{d.label}</span>
                <span className="ml-auto text-[10px] text-slate-500">{d.items.length} 项</span>
              </button>
              {isOpen && (
                <div className="border-t border-white/5 px-3 py-2">
                  <div className="mb-2 text-[10px] text-slate-500">{d.desc}</div>
                  <div className="space-y-1.5">
                    {d.items.map((it) => (
                      <div key={it.node} className="flex items-start gap-2 text-[11px]">
                        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${STATUS_STYLE[it.status]}`}>
                          {it.status === 'ui' ? <CircleCheck size={9} className="mr-0.5 inline" /> : it.status === 'backend' ? <Cpu size={9} className="mr-0.5 inline" /> : <FileUp size={9} className="mr-0.5 inline" />}
                          {STATUS_LABEL[it.status]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-slate-200">
                            {it.label}
                            <span className="ml-1.5 font-mono text-[9px] text-slate-600">{it.node}</span>
                          </div>
                          <div className="text-[10px] text-slate-500">{it.desc} · <span className="text-accent-400/70">{it.where}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
