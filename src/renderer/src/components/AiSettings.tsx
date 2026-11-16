import { useEffect, useState } from 'react'
import { Check, KeyRound, Save } from 'lucide-react'
import type { AiConfig, AiProvider } from '@shared/ai'

export function AiSettings(): React.JSX.Element {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.aiGetConfig().then(setConfig)
  }, [])

  const updateProvider = (id: string, patch: Partial<AiProvider>): void => {
    setConfig((prev) =>
      prev
        ? { ...prev, providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
        : prev
    )
  }

  const save = async (): Promise<void> => {
    if (!config) return
    setSaving(true)
    try {
      const next = await window.api.aiSetConfig(config)
      setConfig(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  if (!config) return <div className="text-sm text-slate-500">读取中…</div>

  return (
    <div className="space-y-3">
      {config.providers.map((p) => {
        const active = config.activeProviderId === p.id
        return (
          <div
            key={p.id}
            className={`rounded-lg border p-3 transition-colors ${
              active ? 'border-accent/50 bg-accent-600/[0.06]' : 'border-white/8 bg-white/[0.02]'
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-white">
                <input
                  type="radio"
                  className="accent-[#7c5cff]"
                  checked={active}
                  onChange={() => setConfig((prev) => (prev ? { ...prev, activeProviderId: p.id } : prev))}
                />
                {p.name || '未命名接口'}
                {active && <span className="rounded bg-accent-600/20 px-1.5 py-0.5 text-[10px] text-accent-400">使用中</span>}
              </label>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div>
                <label className="label">名称</label>
                <input className="field" value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} />
              </div>
              <div>
                <label className="label">模型</label>
                <input
                  className="field"
                  placeholder="deepseek-chat"
                  value={p.model}
                  onChange={(e) => updateProvider(p.id, { model: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">接口地址（OpenAI 兼容 base URL）</label>
                <input
                  className="field"
                  placeholder="https://api.deepseek.com/v1"
                  value={p.baseUrl}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">API Key</label>
                <input
                  className="field font-mono text-xs"
                  type="password"
                  placeholder="sk-..."
                  value={p.apiKey}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                />
              </div>
            </div>
          </div>
        )
      })}

      <div className="flex items-center gap-2">
        <button className="btn-primary" disabled={saving} onClick={() => void save()}>
          {saved ? <Check size={15} /> : <Save size={15} />}
          {saved ? '已保存' : '保存 AI 配置'}
        </button>
        <span className="flex items-center gap-1 text-[11px] text-slate-600">
          <KeyRound size={11} />
          API Key 仅保存在本机（ai-config.json），不会上传。
        </span>
      </div>
    </div>
  )
}
