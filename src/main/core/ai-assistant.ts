import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Project } from '../../shared/types'
import type { AiProvider } from '../../shared/ai'
import type { ProjectStore } from './store.ts'
import { now, uid } from './store.ts'
import { readSkillMain, listSkillRefs, readSkillRef, lintScriptPath } from './skill.ts'

const execFileP = promisify(execFile)

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

type Emit = (e: { type: string; [k: string]: unknown }) => void

type ToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const strObj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required
})

// 暴露给模型的工具（OpenAI function-calling 格式）
const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_project_summary',
      description: '读取当前项目的结构概览：剧本/剧集/场次/分镜/资产的数量与 id 列表。开工先调用。',
      parameters: strObj({})
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: '读取项目记忆（世界观/角色/风格/连续性/决策日志）。开工前必读。',
      parameters: strObj({ key: { type: 'string', enum: ['world', 'characters', 'style', 'continuity', 'decisions'] } }, ['key'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: '覆盖写入某类项目记忆（世界观/角色/风格/连续性）。',
      parameters: strObj({ key: { type: 'string', enum: ['world', 'characters', 'style', 'continuity'] }, content: { type: 'string' } }, ['key', 'content'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'append_decision',
      description: '向决策日志追加一条带时间戳的决策。',
      parameters: strObj({ text: { type: 'string' } }, ['text'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_assets',
      description: '列出项目资产（可过滤 character/scene/prop）。',
      parameters: strObj({ kind: { type: 'string', enum: ['character', 'scene', 'prop'] } })
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_asset',
      description: '新建资产（角色/场景/道具）。',
      parameters: strObj(
        {
          kind: { type: 'string', enum: ['character', 'scene', 'prop'] },
          name: { type: 'string' },
          description: { type: 'string' },
          prompt: { type: 'string', description: '用于生图的英文提示词' },
          negative: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        ['kind', 'name']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_asset',
      description: '修改资产字段（名称/描述/提示词/标签等）。',
      parameters: strObj({ assetId: { type: 'string' }, patch: { type: 'object' } }, ['assetId', 'patch'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_structure',
      description: '列出剧本→剧集→场次的层级 id，便于确定在哪写分镜。',
      parameters: strObj({})
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_shots',
      description: '列出分镜（可按场次过滤）。',
      parameters: strObj({ sceneId: { type: 'string' } })
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_shots',
      description: '在指定场次批量新建分镜。每条分镜的 prompt 写 H3 视频提示词。',
      parameters: strObj(
        {
          sceneId: { type: 'string' },
          shots: {
            type: 'array',
            items: strObj({
              title: { type: 'string' },
              description: { type: 'string', description: '画面描述' },
              prompt: { type: 'string', description: 'H3 视频提示词（详细）' },
              dialogue: { type: 'string' },
              camera: { type: 'string' },
              duration: { type: 'number' }
            })
          }
        },
        ['sceneId', 'shots']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_shot',
      description: '修改一个分镜的字段。',
      parameters: strObj({ shotId: { type: 'string' }, patch: { type: 'object' } }, ['shotId', 'patch'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_skill_references',
      description: '列出 H3 技能可用的参考规则（按需用 read_skill_reference 读取）。',
      parameters: strObj({})
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_reference',
      description: '读取一条 H3 技能参考规则全文（如 h3-format、h3-lexicon-cleanup、camera-movement、spatial-anchor-and-hold 等）。',
      parameters: strObj({ name: { type: 'string' } }, ['name'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'lint_h3_prompt',
      description: '对 H3 提示稿做机检（H1–H36）。传入稿件正文与段时长。',
      parameters: strObj({ text: { type: 'string' }, duration: { type: 'number' } }, ['text'])
    }
  }
]

export class AiAssistant {
  private store: ProjectStore
  private skillsRoot: string
  private changed = false

  constructor(store: ProjectStore, skillsRoot: string) {
    this.store = store
    this.skillsRoot = skillsRoot
  }

  private project(): Project {
    const p = this.store.getCurrent()
    if (!p) throw new Error('请先打开一个项目')
    return p
  }

  private async buildSystem(): Promise<string> {
    const skill = await readSkillMain(this.skillsRoot)
    const refs = await listSkillRefs(this.skillsRoot)
    const refNames = refs.map((r) => r.name).join('、')
    const head = [
      '你是「镜序工坊」内置的 AI 导演助手，人格「漫剧老李」，专精 MiniMax H3（海螺 3.0）短剧。',
      '你必须严格遵守下面的 H3 技能规则（forest-laoli-h3）。',
      '',
      '工作方式：',
      '1) 先用 read_memory 读项目记忆（world/characters/style/continuity），用 list_structure 看剧本结构；',
      '2) 需要细则时用 read_skill_reference 读取对应规则（如 h3-format、h3-lexicon-cleanup、camera-movement、spatial-anchor-and-hold、atmosphere-and-light）；',
      '3) 用 create_asset / add_shots / update_shot 等工具把内容写进项目；写分镜时，把 H3 视频提示词写进 shot.prompt 字段；',
      '4) 出稿后可调用 lint_h3_prompt 做机检，FAIL 必须为 0。',
      '回答用简体中文，简洁、可执行。不要臆造项目里不存在的 id；不确定就读。',
      ''
    ].join('\n')
    const body = skill ? `\n--- H3 技能规则开始 ---\n${skill.slice(0, 16000)}\n--- H3 技能规则结束 ---` : '\n（未找到内置 H3 规则文件，请按通用 H3 规范工作）'
    const refsLine = refNames ? `\n\n可读取的参考规则：${refNames}` : ''
    return head + body + refsLine
  }

  private async callLLM(provider: AiProvider, messages: ChatMsg[]): Promise<ChatMsg> {
    if (!provider.baseUrl || !provider.model) throw new Error('AI 接口未配置完整（baseUrl / model）')
    if (!provider.apiKey) throw new Error('还没有填写 API Key，请到「设置 → AI 助手」填写')
    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.3 })
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`AI 接口 ${res.status}：${t.slice(0, 400)}`)
    }
    const data = (await res.json()) as { choices?: { message?: ChatMsg }[] }
    const msg = data.choices?.[0]?.message
    if (!msg) throw new Error('AI 接口未返回内容')
    return msg
  }

  async chat(provider: AiProvider, history: { role: 'user' | 'assistant'; content: string }[], emit: Emit): Promise<{ content: string; changed: boolean }> {
    this.changed = false
    const project = this.project()
    const messages: ChatMsg[] = [{ role: 'system', content: await this.buildSystem() }]
    for (const h of history) messages.push({ role: h.role, content: h.content })

    const maxSteps = 10
    for (let step = 0; step < maxSteps; step++) {
      emit({ type: 'status', text: step === 0 ? '思考中…' : '继续处理…' })
      const msg = await this.callLLM(provider, messages)
      const toolCalls = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]
      if (!toolCalls.length) {
        return { content: String(msg.content ?? ''), changed: this.changed }
      }
      // 记录 assistant 的 tool_calls
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          args = {}
        }
        emit({ type: 'tool', name: tc.function.name, args, summary: this.describeTool(tc.function.name, args) })
        let result: unknown
        try {
          result = await this.runTool(tc.function.name, args, project)
        } catch (err) {
          result = { error: String((err as Error).message ?? err) }
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }
    // 超过步数：让模型基于已有信息收尾
    messages.push({ role: 'user', content: '请基于以上信息给出最终结果。' })
    const finalMsg = await this.callLLM(provider, messages)
    return { content: String(finalMsg.content ?? ''), changed: this.changed }
  }

  private describeTool(name: string, args: Record<string, unknown>): string {
    const map: Record<string, string> = {
      get_project_summary: '读取项目概览',
      read_memory: `读记忆：${args.key ?? ''}`,
      write_memory: `写记忆：${args.key ?? ''}`,
      append_decision: '追加决策',
      list_assets: '列资产',
      create_asset: `建资产：${args.name ?? ''}`,
      update_asset: '改资产',
      list_structure: '看剧本结构',
      list_shots: '列分镜',
      add_shots: `写分镜（${Array.isArray(args.shots) ? args.shots.length : 0} 条）`,
      update_shot: '改分镜',
      list_skill_references: '列技能规则',
      read_skill_reference: `读规则：${args.name ?? ''}`,
      lint_h3_prompt: 'H3 机检'
    }
    return map[name] ?? name
  }

  private async runTool(name: string, args: Record<string, unknown>, project: Project): Promise<unknown> {
    switch (name) {
      case 'get_project_summary':
        return this.summary(project)
      case 'read_memory':
        return { key: args.key, content: await this.readMem(String(args.key)) }
      case 'write_memory':
        await this.writeMem(String(args.key), String(args.content ?? ''))
        this.changed = true
        return { ok: true }
      case 'append_decision':
        await this.appendDec(String(args.text ?? ''))
        this.changed = true
        return { ok: true }
      case 'list_assets': {
        const kind = args.kind ? String(args.kind) : ''
        return project.assets.filter((a) => !kind || a.kind === kind).map((a) => ({ id: a.id, kind: a.kind, name: a.name, cover: Boolean(a.coverFile) }))
      }
      case 'create_asset': {
        const asset = {
          id: uid('as_'),
          kind: (String(args.kind) as 'character' | 'scene' | 'prop') ?? 'character',
          name: String(args.name ?? '未命名资产'),
          alias: '',
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          description: String(args.description ?? ''),
          prompt: String(args.prompt ?? ''),
          negative: String(args.negative ?? ''),
          coverFile: null as string | null,
          images: [] as string[],
          versions: [] as unknown[],
          createdAt: now(),
          updatedAt: now()
        }
        project.assets.push(asset as never)
        this.changed = true
        return { id: asset.id, name: asset.name, kind: asset.kind }
      }
      case 'update_asset': {
        const a = project.assets.find((x) => x.id === String(args.assetId))
        if (!a) throw new Error(`找不到资产 ${args.assetId}`)
        Object.assign(a, (args.patch ?? {}) as object, { updatedAt: now() })
        this.changed = true
        return { ok: true, id: a.id }
      }
      case 'list_structure':
        return {
          scripts: project.scripts.map((s) => ({ id: s.id, name: s.name, index: s.index })),
          episodes: project.episodes.map((e) => ({ id: e.id, scriptId: e.scriptId, title: e.title, index: e.index })),
          scenes: project.scenes.map((s) => ({ id: s.id, episodeId: s.episodeId, title: s.title, index: s.index }))
        }
      case 'list_shots': {
        const sid = args.sceneId ? String(args.sceneId) : ''
        return project.shots
          .filter((s) => !sid || s.sceneId === sid)
          .map((s) => ({ id: s.id, sceneId: s.sceneId, index: s.index, title: s.title, prompt: s.prompt, status: s.status }))
      }
      case 'add_shots': {
        const sceneId = String(args.sceneId)
        const scene = project.scenes.find((s) => s.id === sceneId)
        if (!scene) throw new Error(`找不到场次 ${sceneId}`)
        const arr = Array.isArray(args.shots) ? (args.shots as Record<string, unknown>[]) : []
        const existing = project.shots.filter((s) => s.sceneId === sceneId)
        let index = existing.length ? Math.max(...existing.map((s) => s.index)) : 0
        const created: { id: string; index: number; title: string }[] = []
        for (const item of arr) {
          index += 1
          const shot = {
            id: uid('sh_'),
            sceneId,
            index,
            title: String(item.title ?? `分镜 ${index}`),
            description: String(item.description ?? ''),
            dialogue: String(item.dialogue ?? ''),
            camera: String(item.camera ?? ''),
            duration: Number(item.duration ?? 5),
            prompt: String(item.prompt ?? ''),
            characterIds: [] as string[],
            assetIds: [] as string[],
            refImage: null,
            status: 'draft' as const,
            outputs: [] as unknown[],
            createdAt: now(),
            updatedAt: now()
          }
          project.shots.push(shot as never)
          created.push({ id: shot.id, index: shot.index, title: shot.title })
        }
        this.changed = true
        return { created: created.length, shots: created }
      }
      case 'update_shot': {
        const s = project.shots.find((x) => x.id === String(args.shotId))
        if (!s) throw new Error(`找不到分镜 ${args.shotId}`)
        Object.assign(s, (args.patch ?? {}) as object, { updatedAt: now() })
        this.changed = true
        return { ok: true, id: s.id }
      }
      case 'list_skill_references': {
        const refs = await listSkillRefs(this.skillsRoot)
        return refs.map((r) => r.name)
      }
      case 'read_skill_reference':
        return { name: args.name, content: (await readSkillRef(this.skillsRoot, String(args.name ?? ''))) || '（未找到该规则）' }
      case 'lint_h3_prompt':
        return { output: await this.runLint(String(args.text ?? ''), Number(args.duration ?? 0)) }
      default:
        throw new Error(`未知工具 ${name}`)
    }
  }

  private summary(project: Project): unknown {
    return {
      project: { id: project.id, name: project.name },
      counts: {
        scripts: project.scripts.length,
        episodes: project.episodes.length,
        scenes: project.scenes.length,
        shots: project.shots.length,
        assets: project.assets.length,
        templates: project.templates.length
      },
      scripts: project.scripts.map((s) => ({ id: s.id, name: s.name }))
    }
  }

  private async readMem(key: string): Promise<string> {
    const dir = this.store.memoryDir()
    const fileMap: Record<string, string> = {
      world: 'world.md',
      characters: 'characters.md',
      style: 'style.md',
      continuity: 'continuity.md',
      decisions: 'decisions.md'
    }
    const f = fileMap[key]
    if (!f) throw new Error(`未知记忆类别 ${key}`)
    try {
      return await fsp.readFile(path.join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }

  private async writeMem(key: string, content: string): Promise<void> {
    const dir = this.store.memoryDir()
    const fileMap: Record<string, string> = { world: 'world.md', characters: 'characters.md', style: 'style.md', continuity: 'continuity.md' }
    const f = fileMap[key]
    if (!f) throw new Error(`未知或不可覆盖的记忆类别 ${key}`)
    await fsp.mkdir(dir, { recursive: true })
    const fp = path.join(dir, f)
    if (fs.existsSync(fp)) await fsp.copyFile(fp, `${fp}.bak`).catch(() => undefined)
    await fsp.writeFile(fp, content, 'utf8')
  }

  private async appendDec(text: string): Promise<void> {
    const body = String(text ?? '').trim()
    if (!body) return
    const dir = this.store.memoryDir()
    await fsp.mkdir(dir, { recursive: true })
    const fp = path.join(dir, 'decisions.md')
    let cur = ''
    try {
      cur = await fsp.readFile(fp, 'utf8')
    } catch {
      cur = ''
    }
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    const piece = `\n## ${stamp}\n\n${body}\n`
    const next = cur ? `${cur.replace(/\s+$/, '')}\n${piece}` : piece.replace(/^\n/, '')
    await fsp.writeFile(fp, next, 'utf8')
  }

  private async findPython(): Promise<string | null> {
    const cands = [process.env.JXGF_PYTHON, 'python', 'py', 'python3'].filter(Boolean) as string[]
    for (const c of cands) {
      try {
        await execFileP(c, ['--version'], { timeout: 8000 })
        return c
      } catch {
        // try next
      }
    }
    return null
  }

  private async runLint(text: string, duration: number): Promise<string> {
    const script = lintScriptPath(this.skillsRoot)
    if (!fs.existsSync(script)) return '（未找到机检脚本 h3_lint.py，跳过机检）'
    if (!text.trim()) return '（空稿件，未机检）'
    const py = await this.findPython()
    if (!py) return '（未找到 Python，跳过机检；规则仍需人工自检）'
    const tmp = path.join(os.tmpdir(), `h3lint_${Date.now()}.md`)
    await fsp.writeFile(tmp, text, 'utf8')
    try {
      const args = [script, tmp]
      if (duration > 0) args.push('--duration', String(duration))
      const { stdout, stderr } = await execFileP(py, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
      return `${stdout || ''}${stderr ? '\n[stderr]\n' + stderr : ''}`.trim() || '（机检无输出）'
    } catch (err) {
      return `机检执行出错：${String((err as Error).message ?? err)}`
    } finally {
      void fsp.unlink(tmp).catch(() => undefined)
    }
  }
}
