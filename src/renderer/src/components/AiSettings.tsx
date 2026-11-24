import { useEffect, useState } from 'react'
import { Check, Download, KeyRound, PlugZap, Save } from 'lucide-react'
import type { AiConfig, AiProvider } from '@shared/ai'

interface TestResult {
  ok: boolean
  message: string
  url?: string
  latencyMs?: number
  reply?: string
}

export function AiSettings({ onSaved }: { onSaved?: (cfg: AiConfig) => void }): React.JSX.Element {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState<string | null>(null)
  const [modelLists, setModelLists] = useState<Record<string, string[]>>({})
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({})

  useEffect(() => {
    void window.api.aiGetConfig().then(setConfig)
  }, [])

  const updateProvider = (id: string, patch: Partial<AiProvider>): void => {
    setConfig((prev) =>
      prev
        ? { ...prev, providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
        : prev
    )
    setTestResult((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (!config) return
    setSaving(true)
    try {
      const next = await window.api.aiSetConfig(config)
      setConfig(next)
      setSaved(true)
      onSaved?.(next)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  /** 测试前先保存，确保主进程用的是当前填写的配置 */
  const test = async (providerId: string): Promise<void> => {
    if (!config) return
    setTesting(providerId)
    try {
      const next = await window.api.aiSetConfig(config)
      setConfig(next)
      const res = (await window.api.aiTest(providerId)) as TestResult
      setTestResult((prev) => ({ ...prev, [providerId]: res }))
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [providerId]: { ok: false, message: String((err as Error).message ?? err) }
      }))
    } finally {
      setTesting(null)
    }
  }

  /** 从网关拉取模型列表，供下拉选择 */
  const loadModels = async (providerId: string): Promise<void> => {
    if (!config) return
    setLoadingModels(providerId)
    try {
      const next = await window.api.aiSetConfig(config)
      setConfig(next)
      const res = await window.api.aiListModels(providerId)
      if (res.ok && res.models.length > 0) {
        setModelLists((prev) => ({ ...prev, [providerId]: res.models }))
        setTestResult((prev) => ({
          ...prev,
          [providerId]: { ok: true, message: `已获取 ${res.models.length} 个模型，可下拉选择` }
        }))
      } else {
        setTestResult((prev) => ({
          ...prev,
          [providerId]: { ok: false, message: res.message ?? '未获取到模型列表（可手动填写模型名）' }
        }))
      }
    } finally {
      setLoadingModels(null)
    }
  }

  if (!config) return <div className="text-sm text-slate-500">读取中…</div>

  return (
    <div className="space-y-3">
      {config.providers.map((p) => {
        const active = config.activeProviderId === p.id
        const result = testResult[p.id]
        const models = modelLists[p.id] ?? []
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
                {active && <span className="rounded bg-accent-600/20 px-1.5 py-0.5 text-[11px] text-accent-400">使用中</span>}
                {!active && <span className="text-[11px] text-amber-400">（未选中，不会使用）</span>}
              </label>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div>
                <label className="label">名称</label>
                <input className="field" value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} />
              </div>
              <div>
                <label className="label">模型 *</label>
                {models.length > 0 ? (
                  <select className="field" value={p.model} onChange={(e) => updateProvider(p.id, { model: e.target.value })}>
                    <option value="">— 选择模型 —</option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="field"
                    placeholder="必填，如 deepseek-chat / marvis/xxx"
                    value={p.model}
                    onChange={(e) => updateProvider(p.id, { model: e.target.value })}
                  />
                )}
              </div>
              <div className="md:col-span-2">
                <label className="label">接口地址（OpenAI 兼容）</label>
                <input
                  className="field"
                  placeholder="https://api.deepseek.com/v1  或  http://127.0.0.1:3425/v1"
                  value={p.baseUrl}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                />
                <div className="mt-1 text-[11px] text-slate-600">
                  填 base 地址（如 .../v1）或完整端点（.../v1/chat/completions）都行，会自动识别。
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="label">API Key（本地网关可留空）</label>
                <input
                  className="field font-mono text-xs"
                  type="password"
                  placeholder="sk-... 或留空（本地免鉴权网关）"
                  value={p.apiKey}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                />
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="btn-ghost py-1 text-xs"
                disabled={loadingModels === p.id}
                onClick={() => void loadModels(p.id)}
              >
                <Download size={13} />
                {loadingModels === p.id ? '拉取中…' : '拉取模型'}
              </button>
              <button className="btn-ghost py-1 text-xs" disabled={testing === p.id} onClick={() => void test(p.id)}>
                <PlugZap size={13} />
                {testing === p.id ? '测试中…' : '测试连接'}
              </button>
              {result && (
                <span className={`text-[11px] ${result.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {result.ok ? '✓ ' : '✗ '}
                  {result.message}
                  {result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ''}
                </span>
              )}
            </div>
            {result && !result.ok && result.url && (
              <div className="mt-1 break-all rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-500">
                实际请求：{result.url}
              </div>
            )}
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
          配置仅保存在本机（ai-config.json），不会上传。
        </span>
      </div>
    </div>
  )
}
