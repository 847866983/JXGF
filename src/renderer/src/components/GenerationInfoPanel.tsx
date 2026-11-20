import type { StageSampler, StageKey } from '../lib/stageDefaults'

/**
 * 生成信息页：全片统一的阶段开关 + 每阶段采样参数。
 * 用表格呈现，每列表头就是参数含义，避免用户不知道数字代表什么。
 */

const STAGES: { key: StageKey; label: string; hint: string }[] = [
  { key: 'first', label: '一采', hint: '第一次采样，出构图与主体' },
  { key: 'second', label: '二采', hint: '放大后重绘，补细节' },
  { key: 'third', label: '三采', hint: '最终高清重绘' },
  { key: 'superRes', label: '超分', hint: 'RTX 超分辨率（需显卡支持）' }
]

const COLS: { key: keyof StageSampler; label: string; width: string; hint: string; type: 'number' | 'text'; step?: number }[] = [
  { key: 'steps', label: '步数', width: 'w-24', hint: '采样迭代次数。越大越细腻，也越慢', type: 'number' },
  { key: 'cfg', label: 'CFG', width: 'w-24', hint: '提示词遵循强度。太低发散，太高发硬，常用 1~7', type: 'number', step: 0.1 },
  { key: 'sampler', label: '采样器', width: 'w-32', hint: '每步怎么走。常用 euler / dpmpp_2m', type: 'text' },
  { key: 'scheduler', label: '调度器', width: 'w-32', hint: '噪声怎么降。常用 simple / beta / karras', type: 'text' },
  { key: 'denoise', label: '降噪', width: 'w-24', hint: '重绘幅度。1=完全重画，0.3~0.5=只修细节', type: 'number', step: 0.05 }
]

export interface GenerationInfoPanelProps {
  stages: Record<StageKey, boolean>
  stageParams: Partial<Record<StageKey, StageSampler>>
  defaults: Partial<Record<StageKey, StageSampler>>
  onToggle: (k: StageKey) => void
  onParam: (k: StageKey, patch: Partial<StageSampler>) => void
}

export function GenerationInfoPanel({
  stages,
  stageParams,
  defaults,
  onToggle,
  onParam
}: GenerationInfoPanelProps): React.JSX.Element {
  return (
    <div className="max-w-5xl space-y-4">
      {/* 阶段开关 */}
      <section className="rounded-xl border border-white/10 bg-ink-900/60 p-4">
        <div className="mb-1 text-sm font-medium text-white">生成阶段</div>
        <div className="mb-3 text-[11px] text-slate-500">勾选哪几段就生成哪几段；只勾一采时只取一采的结果</div>
        <div className="flex flex-wrap gap-2">
          {STAGES.map((s) => {
            const on = stages[s.key]
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onToggle(s.key)}
                title={s.hint}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                  on ? 'border-accent-500 bg-accent-600/20 text-accent-200' : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
                }`}
              >
                <span className={`relative h-4 w-7 shrink-0 rounded-full ${on ? 'bg-accent-500' : 'bg-white/15'}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
                </span>
                <span className="font-medium">{s.label}</span>
                <span className="text-[10px] opacity-60">{s.hint}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* 采样参数表 */}
      <section className="rounded-xl border border-white/10 bg-ink-900/60 p-4">
        <div className="mb-1 text-sm font-medium text-white">采样参数</div>
        <div className="mb-3 text-[11px] text-slate-500">
          每个阶段各自一套；灰色占位 = 工作流原来的值，改了才覆盖
        </div>

        <table className="w-full border-separate border-spacing-y-1 text-xs">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="w-28 pb-1 font-normal">阶段</th>
              {COLS.map((c) => (
                <th key={c.key} className="pb-1 font-normal">
                  <span title={c.hint}>{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAGES.map((s) => {
              const on = stages[s.key]
              const sp = stageParams[s.key] ?? {}
              const d = defaults[s.key] ?? {}
              return (
                <tr key={s.key} className={on ? '' : 'opacity-40'}>
                  <td className="pr-2">
                    <span className={`text-xs ${on ? 'text-slate-200' : 'text-slate-500'}`}>{s.label}</span>
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} className="pr-2">
                      <input
                        className={`field ${c.width} px-2 py-1 text-xs`}
                        type={c.type}
                        step={c.step}
                        disabled={!on}
                        placeholder={String(d[c.key] ?? '默认')}
                        title={c.hint}
                        value={sp[c.key] ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          const v = c.type === 'number' ? Number(raw) || undefined : raw || undefined
                          onParam(s.key, { [c.key]: v } as Partial<StageSampler>)
                        }}
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* 参数说明 */}
        <div className="mt-3 space-y-1 rounded-lg bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-500">
          {COLS.map((c) => (
            <div key={c.key}>
              <span className="text-slate-300">{c.label}</span> —— {c.hint}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
