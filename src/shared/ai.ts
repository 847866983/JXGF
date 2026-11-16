/** 内置 AI 助手的配置：多套 provider 可切换，默认 DeepSeek */

export interface AiProvider {
  id: string
  name: string
  /** deepseek / openai —— 都走 OpenAI 兼容的 /chat/completions */
  kind: 'deepseek' | 'openai'
  /** 例如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 例如 deepseek-chat */
  model: string
  apiKey: string
}

export interface AiConfig {
  providers: AiProvider[]
  activeProviderId: string
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export function defaultAiConfig(): AiConfig {
  return {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek 官方',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: ''
      },
      {
        id: 'custom',
        name: 'OpenAI 兼容',
        kind: 'openai',
        baseUrl: '',
        model: '',
        apiKey: ''
      }
    ],
    activeProviderId: 'deepseek'
  }
}

export function normalizeAiConfig(raw: unknown): AiConfig {
  const base = defaultAiConfig()
  const obj = (raw ?? {}) as Partial<AiConfig>
  const providers = Array.isArray(obj.providers) && obj.providers.length > 0 ? obj.providers : base.providers
  const mapped: AiProvider[] = providers.map((p, i) => ({
    id: String((p as AiProvider)?.id ?? `p${i}`),
    name: String((p as AiProvider)?.name ?? `接口 ${i + 1}`),
    kind: ((p as AiProvider)?.kind === 'openai' ? 'openai' : 'deepseek') as AiProvider['kind'],
    baseUrl: String((p as AiProvider)?.baseUrl ?? ''),
    model: String((p as AiProvider)?.model ?? ''),
    apiKey: String((p as AiProvider)?.apiKey ?? '')
  }))
  const active = String(obj.activeProviderId ?? '')
  return {
    providers: mapped,
    activeProviderId: mapped.some((p) => p.id === active) ? active : mapped[0].id
  }
}
