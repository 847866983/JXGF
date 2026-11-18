import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Project } from '@shared/types'

/**
 * 模型搬家：把工作流引用的模型从一台机器搬到另一台。
 *
 * 背景：部分模型是社区/私有版本（如 QuadView_krea2_v1、rayQwen21编辑强化、krea2 系 LoRA），
 * 官方站点下载不到，只能从已有机器拷贝。此模块提供：
 *   - listReferencedModels：从项目模板解析引用到的模型，定位到 models 下的相对路径与大小
 *   - exportModelPack：把选中模型按 models 目录结构打包为 .7z
 *   - importModelPack：把 .7z 解压回 models 目录（保留子目录）
 */

export interface ReferencedModel {
  /** 文件名（模板里引用的名字） */
  name: string
  /** 相对 ComfyUI/models 的路径，如 loras/QuadView_krea2_v1.safetensors */
  relativePath: string
  /** 实际绝对路径；本地缺失时为空 */
  absPath: string | null
  sizeMB: number
  exists: boolean
  /** 被哪些模板使用 */
  usedBy: string[]
}

/** 从项目模板里收集所有被引用的模型文件名 */
export function collectModelRefs(project: Project): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  const isModelFile = (v: string): boolean => /\.(safetensors|pth|pt|ckpt|bin|onnx)$/i.test(v)
  for (const t of project.templates ?? []) {
    const api = t.apiJson as Record<string, { inputs?: Record<string, unknown> }> | undefined
    if (!api || typeof api !== 'object') continue
    for (const node of Object.values(api)) {
      for (const v of Object.values(node?.inputs ?? {})) {
        if (typeof v === 'string' && isModelFile(v)) {
          const name = path.basename(v.replace(/\\/g, '/'))
          if (!refs.has(name)) refs.set(name, new Set())
          refs.get(name)!.add(t.name)
        }
      }
    }
  }
  return refs
}

/** 在 models 目录下递归查找某文件名（限制深度，返回相对路径） */
async function findModel(modelsRoot: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  const entries = await fsp.readdir(modelsRoot, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = path.join(modelsRoot, e.name)
    if (e.isFile() && e.name === name) return path.relative(modelsRoot, p)
    if (e.isDirectory()) {
      const r = await findModel(p, name, depth + 1)
      if (r) return path.join(e.name, r)
    }
  }
  return null
}

/** 列出项目引用的全部模型及其本地状态 */
export async function listReferencedModels(project: Project, modelsRoot: string): Promise<ReferencedModel[]> {
  const refs = collectModelRefs(project)
  const out: ReferencedModel[] = []
  for (const [name, usedBy] of [...refs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rel = await findModel(modelsRoot, name)
    if (rel) {
      const abs = path.join(modelsRoot, rel)
      let sizeMB = 0
      try {
        sizeMB = Math.round(((await fsp.stat(abs)).size / 1024 / 1024) * 10) / 10
      } catch {
        // ignore
      }
      out.push({ name, relativePath: rel.replace(/\\/g, '/'), absPath: abs, sizeMB, exists: true, usedBy: [...usedBy] })
    } else {
      out.push({ name, relativePath: '', absPath: null, sizeMB: 0, exists: false, usedBy: [...usedBy] })
    }
  }
  return out
}

function find7z(resourcesPath: string, appPath: string): string | null {
  const cands = [path.join(resourcesPath, 'tools', '7za.exe'), path.join(appPath, 'resources', 'tools', '7za.exe'), '7z.exe']
  for (const c of cands) {
    if (!c.includes(path.sep) && !c.includes('/')) return c
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // next
    }
  }
  return null
}

function run(cmd: string, args: string[], cwd?: string, onLine?: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd })
    child.stdout.on('data', (d: Buffer) => onLine?.(d.toString()))
    child.stderr.on('data', (d: Buffer) => onLine?.(d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`命令退出码 ${code}`))))
  })
}

/**
 * 导出选中模型为 .7z（保留 models 下的相对子目录结构）。
 * 通过 -spf 绝对路径列表 + 工作目录方式保持目录层级。
 */
export async function exportModelPack(
  items: { absPath: string; relativePath: string }[],
  outFile: string,
  modelsRoot: string,
  sevenZip: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  if (items.length === 0) throw new Error('没有选中任何模型')
  await fsp.mkdir(path.dirname(outFile), { recursive: true })
  await fsp.rm(outFile, { force: true }).catch(() => undefined)
  // 用列表文件：每行是相对 modelsRoot 的路径，-spf 表示用绝对路径解释
  const listFile = `${outFile}.list.txt`
  await fsp.writeFile(listFile, items.map((i) => i.relativePath.replace(/\//g, '\\')).join('\r\n'), 'utf8')
  try {
    onProgress?.(`正在打包 ${items.length} 个模型…`)
    // -spf2: 绝对路径但保留目录结构；用 -w 指定工作目录更稳
    await run(sevenZip, ['a', '-t7z', '-mx=1', outFile, `@${listFile}`], modelsRoot, (line) => {
      const m = /(\d+)%/.exec(line)
      if (m) onProgress?.(`打包中 ${m[1]}%`)
    })
  } finally {
    await fsp.rm(listFile, { force: true }).catch(() => undefined)
  }
}

/** 导入模型包到 models 目录（保留包内子目录结构） */
export async function importModelPack(
  packFile: string,
  modelsRoot: string,
  sevenZip: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  await fsp.mkdir(modelsRoot, { recursive: true })
  onProgress?.('正在解压模型包…')
  await run(sevenZip, ['x', '-y', packFile, `-o${modelsRoot}`], undefined, (line) => {
    const m = /(\d+)%/.exec(line)
    if (m) onProgress?.(`解压中 ${m[1]}%`)
  })
}

export { find7z }
