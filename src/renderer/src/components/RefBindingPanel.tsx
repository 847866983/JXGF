import { useState } from 'react'
import { Check, Image as ImageIcon, Link2, PlugZap, Plus, X } from 'lucide-react'

/**
 * 参考图绑定面板 —— 以「名字」为中心的绑定方式。
 *
 * H3 的绑定机制（csglide_cast.py）支持两条路：
 *   · 别名模式开（默认）：提示词里写角色名 → H3 按槽位 alias 自动展开成 @图片N；
 *   · 别名模式关：只能显式写 @图片N。
 *
 * 本面板走第一条：把资产名作为绑定令牌，点「绑定」即把名字写进提示词，
 * 提交时主进程把同一份名字写进媒体架槽位 alias，两边对上即可调用参考图。
 * 用户不必再理解 @图片N —— 它只作为角标显示，便于兼容旧写法。
 */

export interface RefPick {
  index: number
  /** 资产 id（用于移除） */
  assetId?: string
  /** 资产名 = 绑定令牌 */
  name: string
  image: string | null
  /** 提示词里是否已出现该名字或对应 @标签 */
  used: boolean
  /** 该资产是否已有可用图片（没图会在生成时报错） */
  hasImage?: boolean
}

export interface RefAssetOption {
  id: string
  name: string
  image: string | null
}

export function RefBindingPanel({
  picks,
  aliasMode,
  prompt,
  available,
  onAdd,
  onRemove,
  onToggleAlias,
  onBind,
  onUnbind
}: {
  picks: RefPick[]
  aliasMode: boolean
  prompt: string
  /** 可加入的资产（尚未被引用的） */
  available?: RefAssetOption[]
  onAdd?: (assetId: string) => void
  onRemove?: (assetId: string) => void
  onToggleAlias: (v: boolean) => void
  /** 把「名字」写进提示词 */
  onBind: (name: string) => void
  /** 从提示词移除「名字」+ 兼容清理对应的 @图片N */
  onUnbind: (name: string, tag: string) => void
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const usedCount = picks.filter((p) => p.used).length

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
        <div className="mb-0.5 flex items-center gap-2">
          <Link2 size={13} className="text-accent-400" />
          <span className="text-[11px] font-medium text-slate-200">参考图绑定</span>
          <span className="ml-auto text-[11px] text-slate-500">{usedCount}/{picks.length} 已绑定</span>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
          在提示词里写<strong className="font-medium text-slate-300">名字</strong>即可调用对应参考图，点下面的按钮自动写入。
        </p>

        {picks.length === 0 ? (
          <div className="flex items-center gap-1.5 py-1 text-[11px] text-slate-500">
            <ImageIcon size={11} />
            本段还没有引用资产 —— 点「＋ 加参考图」从资产库选。
          </div>
        ) : (
          <div className="space-y-1">
            {picks.map((p) => {
              const tag = `@图片${p.index}`
              return (
                <div
                  key={tag}
                  className={`flex items-center gap-2 rounded-md border px-1.5 py-1.5 ${
                    p.used ? 'border-accent-500/40 bg-accent-600/10' : 'border-white/[0.06] bg-white/[0.02]'
                  }`}
                >
                  {p.image ? (
                    <img src={p.image} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-white/[0.05] text-slate-600" title="该资产还没有图片，生成前需先生成">
                      <ImageIcon size={13} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-slate-200" title={p.name}>
                        {p.name}
                      </span>
                      {p.hasImage === false && <span className="shrink-0 text-[11px] text-amber-400/80">无图</span>}
                    </div>
                    <span className="text-[11px] text-slate-600">槽位 {tag}</span>
                  </div>
                  {p.used && <Check size={12} className="shrink-0 text-accent-400" />}
                  <button
                    className={`shrink-0 rounded px-2 py-1 text-[11px] transition-colors ${
                      p.used
                        ? 'bg-white/[0.06] text-slate-400 hover:bg-white/[0.1]'
                        : 'bg-accent-600/20 text-accent-300 hover:bg-accent-600/35'
                    }`}
                    title={p.used ? `从提示词移除「${p.name}」` : `把「${p.name}」写进提示词以绑定这张参考图`}
                    onClick={() => (p.used ? onUnbind(p.name, tag) : onBind(p.name))}
                  >
                    {p.used ? '取消' : '绑定'}
                  </button>
                  {onRemove && p.assetId && (
                    <button
                      className="shrink-0 rounded p-0.5 text-slate-600 hover:bg-rose-500/10 hover:text-rose-400"
                      title="从本段移除这张参考图"
                      onClick={() => onRemove(p.assetId!)}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 一键加参考图：从资产库选，直接加入本段（闭环：生成图 → 绑定 → 提示词） */}
        {onAdd && (
          <div className="mt-2 border-t border-white/[0.06] pt-2">
            <button
              className="flex w-full items-center gap-1.5 text-left text-[11px] text-accent-300 hover:text-accent-200"
              onClick={() => setPickerOpen((v) => !v)}
            >
              <Plus size={11} />
              {pickerOpen ? '收起资产列表' : '＋ 加参考图 / 移除'}
            </button>
            {pickerOpen && (
              <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded border border-white/[0.06] bg-black/20 p-1">
                {(available ?? []).length === 0 && (
                  <div className="px-1 py-2 text-[11px] text-slate-600">资产库里没有未引用的资产了</div>
                )}
                {(available ?? []).map((a) => (
                  <button
                    key={a.id}
                    className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/[0.05]"
                    onClick={() => {
                      onAdd(a.id)
                      setPickerOpen(false)
                    }}
                    title={`加入本段参考图：${a.name}`}
                  >
                    {a.image ? (
                      <img src={a.image} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/[0.05] text-slate-600">
                        <ImageIcon size={11} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{a.name}</span>
                    <Plus size={11} className="shrink-0 text-accent-400" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 名字绑定开关 —— 名字令牌依赖别名模式展开，默认必须开 */}
      <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <PlugZap size={12} className={aliasMode ? 'text-emerald-400' : 'text-amber-400'} />
          <span className="text-[11px] text-slate-400">名字绑定模式</span>
        </div>
        <button
          onClick={() => onToggleAlias(!aliasMode)}
          className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
            aliasMode
              ? 'bg-emerald-600/25 text-emerald-300'
              : 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/35'
          }`}
          title="开启后，提示词里写资产名会自动调用对应参考图；关闭则名字不生效"
        >
          {aliasMode ? '开' : '关'}
        </button>
      </div>

      {!aliasMode && picks.length > 0 && (
        <div className="rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300/90">
          名字绑定已关闭 —— 现在写名字不生效，只能手写 @图片N。建议打开上面的开关。
        </div>
      )}
      {aliasMode && prompt.trim().length > 0 && picks.length > 0 && picks.every((p) => !p.used) && (
        <div className="rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300/90">
          提示词里还没写这些资产的名字 —— 按 H3「写了才送」的规则，这些参考图这次不会被送进模型。点上面的「绑定」把名字写进去。
        </div>
      )}
    </div>
  )
}
