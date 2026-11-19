import fs from 'node:fs'
import path from 'node:path'
import type { Template } from '@shared/types'

/**
 * 内置工作流：随软件分发的图片/视频生成工作流，用户无需手动导入。
 * - 打包后位于 resources/workflows/（由 electron-builder extraResources 复制）
 * - 开发态位于项目根 resources/workflows/
 * 软件在打开/新建项目时自动把这批工作流 seed 进 project.templates（按 name 去重，缺哪个补哪个）。
 *
 * 支持两种文件格式：
 *   1) 已封装格式：{ name, kind, apiJson, mapping }  ← 旧版内置文件
 *   2) ComfyUI 原生导出：{ nodes, links, ... }        ← 用户直接从 ComfyUI 另存的 UI 格式
 * UI 格式原样存进 apiJson，提交前由 convertUiToApi 按 ComfyUI 在线信息转换。
 */

export interface BuiltinWorkflowFile {
  id: string
  name: string
  kind: 'image' | 'video'
  file: string
}

function workflowsDir(): string {
  // 打包态：process.resourcesPath/workflows；开发态：<cwd>/resources/workflows
  const packed = path.join(process.resourcesPath ?? '', 'workflows')
  if (fs.existsSync(packed)) return packed
  return path.join(process.cwd(), 'resources', 'workflows')
}

/** 读取内置工作流清单 */
export function listBuiltinWorkflows(): BuiltinWorkflowFile[] {
  const dir = workflowsDir()
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
    return JSON.parse(raw) as BuiltinWorkflowFile[]
  } catch {
    return []
  }
}

/** 读取某个内置工作流的完整定义（兼容封装格式与 ComfyUI UI 格式） */
export function loadBuiltinWorkflow(file: string): Omit<Template, 'id' | 'createdAt'> | null {
  const dir = workflowsDir()
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    const data = JSON.parse(raw) as {
      name?: string
      kind?: 'image' | 'video'
      apiJson?: unknown
      mapping?: Template['mapping']
      nodes?: unknown[]
      links?: unknown[]
    }

    // 名称/类型优先用文件里的字段；UI 格式没有时回落到 manifest 登记的名字
    const meta = listBuiltinWorkflows().find((m) => m.file === file)
    const name = data.name ?? meta?.name ?? file.replace(/\.json$/i, '')
    const kind = data.kind ?? meta?.kind ?? 'image'

    // ① 已封装格式：直接用 apiJson
    if (data.apiJson && typeof data.apiJson === 'object') {
      return {
        name,
        kind,
        apiJson: data.apiJson,
        mapping: data.mapping ?? { version: 1 }
      }
    }

    // ② ComfyUI UI 格式：把整个文件当 apiJson 存（提交时再转 API）
    if (Array.isArray(data.nodes)) {
      return {
        name,
        kind,
        apiJson: data as unknown,
        mapping: data.mapping ?? { version: 1 }
      }
    }

    return null
  } catch {
    return null
  }
}

/** 把内置工作流按模板列表补全（按 name 去重；已存在的同名模板跳过） */
export function buildBuiltinTemplates(existing: Template[], uid: (p: string) => string, now: () => string): Template[] {
  const have = new Set(existing.map((t) => t.name))
  const added: Template[] = []
  for (const meta of listBuiltinWorkflows()) {
    if (have.has(meta.name)) continue
    const wf = loadBuiltinWorkflow(meta.file)
    if (!wf) continue
    added.push({
      id: uid('tpl_'),
      name: wf.name,
      kind: wf.kind,
      apiJson: wf.apiJson,
      mapping: wf.mapping,
      createdAt: now()
    })
    have.add(meta.name)
  }
  return added
}
