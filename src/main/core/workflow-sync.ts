import fs from 'node:fs'
import path from 'node:path'
import type { Template } from '@shared/types'

/**
 * 从 ComfyUI 网页端同步工作流。
 *
 * 背景：软件里的工作流是导入时复制的一份快照。用户在 ComfyUI 网页端改了配置
 * （关 LoRA、调采样器、改提示词…），软件不会自动跟着变。本模块提供显式同步：
 * 读取 ComfyUI 的 user/default/workflows/ 目录，按名字匹配项目里已有的模板，
 * 整份替换成网页端的最新版本。
 */

export interface SyncCandidate {
  /** 网页端文件绝对路径 */
  file: string
  /** 工作流名（文件名去扩展名） */
  name: string
  /** 文件大小 */
  size: number
  /** 最后修改时间 */
  mtime: string
  /** 项目里是否已有同名模板 */
  inProject: boolean
  /** 项目里该模板的 id（有则说明会被替换） */
  templateId?: string
}

/** ComfyUI 的工作流目录（兼容便携版与绘世启动器布局） */
export function comfyWorkflowDirs(comfyRoot: string | null): string[] {
  const out: string[] = []
  if (!comfyRoot) return out
  const bases = [
    path.join(comfyRoot, 'ComfyUI'),
    path.join(comfyRoot, 'ComfyUI', 'ComfyUI'),
    comfyRoot
  ]
  for (const b of bases) {
    out.push(path.join(b, 'user', 'default', 'workflows'))
    out.push(path.join(b, 'user', 'workflows'))
    out.push(path.join(b, 'workflows'))
  }
  return [...new Set(out)]
}

/** 列出 ComfyUI 网页端的工作流文件，并标注项目里是否已有同名模板 */
export function listComfyWorkflows(comfyRoot: string | null, project: Template[] | null): SyncCandidate[] {
  // 建立「可匹配键 → 模板」索引：模板名、模板名去 emoji/符号、内置 manifest 里的登记名
  const byKey = new Map<string, string>()
  for (const t of project ?? []) {
    byKey.set(normalizeKey(t.name), t.id)
  }

  const out: SyncCandidate[] = []
  const seen = new Set<string>()
  for (const dir of comfyWorkflowDirs(comfyRoot)) {
    if (!fs.existsSync(dir)) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.json$/i.test(e.name)) continue
      const full = path.join(dir, e.name)
      if (seen.has(full)) continue
      seen.add(full)
      const name = e.name.replace(/\.json$/i, '')
      let size = 0
      let mtime = ''
      try {
        const st = fs.statSync(full)
        size = st.size
        mtime = st.mtime.toISOString()
      } catch {
        continue
      }
      const key = normalizeKey(name)
      out.push({
        file: full,
        name,
        size,
        mtime,
        inProject: byKey.has(key),
        templateId: byKey.get(key)
      })
    }
    if (out.length > 0) break
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/**
 * 归一化匹配键：去掉 emoji、标点、空格、大小写差异，
 * 让「MiniMax H3 三采」和「minimax h3-三采-1031」能对上。
 */
export function normalizeKey(name: string): string {
  const base = name
    .toLowerCase()
    // 去 emoji 与符号
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    // 去常见分隔符与标点
    .replace(/[\s\-_·、。，,.()（）[\]【】:：/\\]/g, '')
    // 去尾部纯数字版本号（如 -1031 / -1023 / 1027）
    .replace(/\d{4}$/, '')
    .trim()
  // 别名归一：中英文命名差异大的工作流，手动对齐到同一个键
  for (const [canon, aliases] of Object.entries(NAME_ALIASES)) {
    if (aliases.some((a) => base.includes(a))) return canon
  }
  return base
}

/**
 * 中英文命名差异过大的工作流别名表。
 * key 是统一归一键，value 是能被识别出的片段（按顺序匹配，先命中先用）。
 * 注意片段要足够独特，避免误匹配（如 'h3' 会撞到无关名字，改用 'minimaxh3'）。
 */
const NAME_ALIASES: Record<string, string[]> = {
  moss: ['moss'],
  qwenimage: ['qwenimage', '千问image', '千问图片'],
  minimaxh3: ['minimaxh3'],
  krea2singledouble: ['krea2单双采'],
  krea2quadview: ['krea2角色资产四视图', 'krea2四视图'],
  krea2edit: ['krea2图像编辑', 'krea2图片编辑'],
  zimage: ['zimageturbo', 'zimage'],
  acemusic: ['ace音乐'],
  yue2: ['yue2']
}

/** 读取一个网页端工作流文件，转成模板可用的 apiJson（UI 格式原样保存） */
export function readComfyWorkflow(file: string): { apiJson: unknown; name: string } | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as { nodes?: unknown[]; name?: string }
    if (!Array.isArray(data.nodes)) return null
    return {
      apiJson: data,
      name: data.name ?? path.basename(file).replace(/\.json$/i, '')
    }
  } catch {
    return null
  }
}
