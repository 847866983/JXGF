/**
 * 记忆库（本地长期记忆）定义。
 * 每个项目目录下有一个 memory/ 文件夹，存纯 markdown 文件；
 * AI 通过 MCP 工具、用户通过界面都能读写，换电脑/换 AI 都不丢。
 */

export interface MemoryFileDef {
  key: string
  file: string
  label: string
  hint: string
  /** 是否只追加（决策日志） */
  appendOnly?: boolean
}

export const MEMORY_DIR = 'memory'

export const MEMORY_FILES: MemoryFileDef[] = [
  {
    key: 'world',
    file: 'world.md',
    label: '世界观 / 设定',
    hint: '时代、地点、规则、氛围基调等'
  },
  {
    key: 'characters',
    file: 'characters.md',
    label: '角色小传',
    hint: '每个角色的身份、外形、性格、动机、口头禅、关系'
  },
  {
    key: 'style',
    file: 'style.md',
    label: '画风 / 文风 / 镜头',
    hint: '画面风格、镜头语言、用词习惯、参考作品'
  },
  {
    key: 'continuity',
    file: 'continuity.md',
    label: '时间线 / 连续性',
    hint: '谁在第几场穿什么、发生过什么、不能矛盾的细节'
  },
  {
    key: 'decisions',
    file: 'decisions.md',
    label: '决策日志',
    hint: '每次定稿的决策，只追加不覆盖，形成历史账本',
    appendOnly: true
  }
]

export function memoryFileOf(key: string): MemoryFileDef | undefined {
  return MEMORY_FILES.find((f) => f.key === key)
}

export interface MemoryEntry {
  key: string
  file: string
  label: string
  hint: string
  appendOnly: boolean
  exists: boolean
  size: number
  updatedAt: string | null
}
