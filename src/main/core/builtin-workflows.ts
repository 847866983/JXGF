import fs from 'node:fs'
import path from 'node:path'
import type { Template } from '@shared/types'

/**
 * 内置工作流：随软件分发的图片/视频生成工作流，用户无需手动导入。
 * - 打包后位于 resources/workflows/（由 electron-builder extraResources 复制）
 * - 开发态位于项目根 resources/workflows/
 * 软件在打开/新建项目时自动把这批工作流 seed 进 project.templates（按 name 去重，缺哪个补哪个）。
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

/** 读取某个内置工作流的完整定义（含 apiJson） */
export function loadBuiltinWorkflow(file: string): Omit<Template, 'id' | 'createdAt'> | null {
  const dir = workflowsDir()
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    const data = JSON.parse(raw) as { name: string; kind: 'image' | 'video'; apiJson: unknown; mapping?: Template['mapping'] }
    return {
      name: data.name,
      kind: data.kind,
      apiJson: data.apiJson,
      mapping: data.mapping ?? { version: 1 }
    }
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
