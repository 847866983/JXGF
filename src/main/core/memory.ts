import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MEMORY_FILES, memoryFileOf, type MemoryEntry } from '../../shared/memory.ts'

/** 记忆库文件操作（纯 Node，项目目录由调用方给出） */

function fileOf(key: string): string {
  const def = memoryFileOf(key)
  if (!def) throw new Error(`未知的记忆文件：${key}`)
  return def.file
}

export async function listMemory(dir: string): Promise<MemoryEntry[]> {
  await fsp.mkdir(dir, { recursive: true })
  const out: MemoryEntry[] = []
  for (const f of MEMORY_FILES) {
    const fp = path.join(dir, f.file)
    let exists = false
    let size = 0
    let updatedAt: string | null = null
    try {
      const st = await fsp.stat(fp)
      exists = true
      size = st.size
      updatedAt = st.mtime.toISOString()
    } catch {
      // 文件不存在
    }
    out.push({
      key: f.key,
      file: f.file,
      label: f.label,
      hint: f.hint,
      appendOnly: Boolean(f.appendOnly),
      exists,
      size,
      updatedAt
    })
  }
  return out
}

export async function readMemory(dir: string, key: string): Promise<string> {
  const fp = path.join(dir, fileOf(key))
  try {
    return await fsp.readFile(fp, 'utf8')
  } catch {
    return ''
  }
}

export async function writeMemory(dir: string, key: string, content: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  const fp = path.join(dir, fileOf(key))
  // 覆盖前留上一版备份
  if (fs.existsSync(fp)) {
    await fsp.copyFile(fp, `${fp}.bak`).catch(() => undefined)
  }
  await fsp.writeFile(fp, content, 'utf8')
}

function formatStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 只追加（用于决策日志）：新内容以带时间戳的小节追加到末尾 */
export async function appendMemory(dir: string, key: string, text: string): Promise<void> {
  const body = String(text ?? '').trim()
  if (!body) return
  await fsp.mkdir(dir, { recursive: true })
  const fp = path.join(dir, fileOf(key))
  let existing = ''
  try {
    existing = await fsp.readFile(fp, 'utf8')
  } catch {
    existing = ''
  }
  const piece = `\n## ${formatStamp(new Date())}\n\n${body}\n`
  const next = existing ? `${existing.replace(/\s+$/, '')}\n${piece}` : piece.replace(/^\n/, '')
  await fsp.writeFile(fp, next, 'utf8')
}
