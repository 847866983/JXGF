import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Send, Settings2, Sparkles, User, Wrench } from 'lucide-react'
import type { AiConfig } from '@shared/ai'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { NoProject } from '../components/NoProject'

interface Msg {
  role: 'user' | 'assistant'
  content: string
}

export default function AiAssistant(): React.JSX.Element {
  const project = useApp((s) => s.project)
  const openProject = useApp((s) => s.openProject)
  const navigate = useNavigate()

  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [liveTools, setLiveTools] = useState<string[]>([])
  const [config, setConfig] = useState<AiConfig | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.aiGetConfig().then(setConfig)
  }, [])

  // 订阅 AI 进度事件
  useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === 'ai:status') setStatusText(e.text)
      else if (e.type === 'ai:tool') {
        setLiveTools((prev) => [...prev, e.summary || e.name])
      } else if (e.type === 'ai:error') {
        // 错误由 aiChat 的 reject 处理
      }
    })
    return off
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, liveTools, statusText])

  const activeProvider = config?.providers.find((p) => p.id === config.activeProviderId) ?? null
  const keyMissing = !activeProvider?.apiKey || !activeProvider?.baseUrl || !activeProvider?.model

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || sending || !project) return
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setSending(true)
    setStatusText('思考中…')
    setLiveTools([])
    try {
      const res = await window.api.aiChat({ messages: next })
      setMessages([...next, { role: 'assistant', content: res.content || '（无回复）' }])
      if (res.changed) {
        await openProject(project.id)
      }
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: `⚠️ ${String((err as Error).message ?? err)}` }])
    } finally {
      setSending(false)
      setStatusText('')
      setLiveTools([])
    }
  }

  if (!project) {
    return (
      <div>
        <PageHeader title="AI 助手" desc="内置 H3AI 导演助理" />
        <div className="px-8 pb-8">
          <NoProject />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      <PageHeader
        title="AI 助手"
        desc="H3AI 导演助理 · 会读记忆、按 H3 规则写分镜、可做机检"
        actions={
          <button className="btn-ghost" onClick={() => navigate('/settings')}>
            <Settings2 size={15} />
            AI 接口设置
          </button>
        }
      />

      {keyMissing && (
        <div className="mx-8 mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          <span>还没有配置 AI 接口的 API Key，无法对话。</span>
          <button className="btn-primary py-1 text-xs" onClick={() => navigate('/settings')}>
            去设置
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-0 px-8 pb-4">
        <div className="panel flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-accent-400" />
              当前接口：{activeProvider?.name ?? '未配置'}
              {activeProvider?.model ? ` · ${activeProvider.model}` : ''}
            </span>
            <span>{project.name}</span>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="mx-auto mt-8 max-w-md text-center text-sm text-slate-500">
                <Bot size={36} className="mx-auto mb-3 text-slate-600" />
                你好，我是 H3AI 导演助理。
                <div className="mt-2 text-xs text-slate-600">
                  可以让我：读项目记忆 → 设计角色/场景资产 → 按 H3 规则写分镜提示词 → 机检。
                  <br />
                  例如：「先读记忆，然后给第一场写 3 个分镜的 H3 提示词」。
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-600/20 text-accent-400">
                    <Bot size={15} />
                  </div>
                )}
                <div
                  className={`max-w-[78%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-accent-600 text-white'
                      : 'bg-ink-850 text-slate-200'
                  }`}
                >
                  {m.content}
                </div>
                {m.role === 'user' && (
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-slate-300">
                    <User size={15} />
                  </div>
                )}
              </div>
            ))}

            {sending && (
              <div className="flex flex-col gap-1.5">
                {(liveTools.length > 0 || statusText) && (
                  <div className="flex items-start gap-2 text-xs text-slate-500">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-600/20 text-accent-400">
                      <Bot size={15} />
                    </div>
                    <div className="space-y-1">
                      {statusText && <div className="text-slate-400">{statusText}</div>}
                      {liveTools.map((t, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-slate-500">
                          <Wrench size={11} />
                          {t}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-white/5 p-3">
            <div className="flex items-end gap-2">
              <textarea
                className="field min-h-[44px] flex-1 resize-none py-2.5"
                rows={1}
                placeholder={keyMissing ? '请先在设置里配置 AI 接口' : '输入指令，Enter 发送，Shift+Enter 换行'}
                value={input}
                disabled={keyMissing || sending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button className="btn-primary h-[44px]" disabled={sending || keyMissing || !input.trim()} onClick={() => void send()}>
                <Send size={15} />
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
