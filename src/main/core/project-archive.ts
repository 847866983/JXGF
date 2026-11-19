import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Project } from '@shared/types'

/**
 * 整个工程的导出 / 导入（单文件 .jxproj，其实就是标准 ZIP）。
 *
 * 打包内容：
 *   project.json    整份工程数据（剧本 / 分镜 / 资产 / 模板 / 设置）
 *   media/NNN_xxx   工程引用到的**全部媒体文件**：资产图、封面、各版本图、分镜成片…
 *   manifest.json   格式标识与统计
 *
 * 媒体文件在 project.json 里的绝对路径会被换成包内的相对路径 `media/...`；
 * 导入时再按新工程的 media 目录还原成绝对路径。所以换一台机器也能直接用。
 */

const MARK = '__JXGF_MEDIA__'
const FORMAT = 'jxgf-project'
const VERSION = 1
/** ZIP（非 ZIP64）单文件上限保守值 */
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024 * 1024

export interface ExportResult {
  outPath: string
  mediaCount: number
  totalBytes: number
  missing: number
}

export interface ImportResult {
  project: Project
  mediaCount: number
  restoredDir: string
}

/* ------------------------------------------------------------------ CRC32 */

let CRC_TABLE: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

function crc32(buf: Buffer): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ ZIP 写 */

interface ZipEntry {
  name: string
  data: Buffer
}

function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const e of entries) {
    const data = e.data
    const crc = crc32(data)
    const deflated = zlib.deflateRawSync(data, { level: 6 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const nameBuf = Buffer.from(e.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

/* ------------------------------------------------------------------ ZIP 读 */

function readZip(buf: Buffer): ZipEntry[] {
  // 从尾部找 EOCD（最多扫 64KB）
  let eocd = -1
  const start = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/工程包（找不到目录尾）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  let p = cdOffset

  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) break
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)

    out.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/* ------------------------------------------------------------------ 工具 */

/** 递归收集工程里所有「真实存在于磁盘的文件」的绝对路径 */
export function collectProjectFiles(value: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(v)) return
      try {
        if (fs.existsSync(v) && fs.statSync(v).isFile()) out.add(v)
      } catch {
        /* 权限/占用，跳过 */
      }
      return
    }
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x)
    }
  }
  walk(value)
  return [...out]
}

function safeBase(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return s || 'file'
}

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

function newId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `prj_${t}${r}`
}

/* ------------------------------------------------------------------ 导出 */

export async function exportProjectToFile(project: Project, outPath: string): Promise<ExportResult> {
  const files = collectProjectFiles(project)
  let total = 0
  let missing = 0
  const entries: ZipEntry[] = []
  const map = new Map<string, string>()

  let i = 0
  for (const abs of files) {
    try {
      const data = await fsp.readFile(abs)
      total += data.length
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(
          `工程媒体超过 ${(MAX_TOTAL_BYTES / 1024 ** 3).toFixed(1)}GB，单个工程包放不下。` +
            `请先清理不需要的成片再导出。`
        )
      }
      i += 1
      const name = `${MARK}/media/${String(i).padStart(3, '0')}_${safeBase(path.basename(abs))}`
      entries.push({ name, data })
      map.set(abs, name)
    } catch (err) {
      if (String((err as Error).message).includes('GB')) throw err
      missing += 1
    }
  }

  // 把工程里出现的绝对路径替换成包内相对路径
  let json = JSON.stringify(project, null, 2)
  for (const [abs, rel] of map) {
    json = json.split(jsonEscape(abs)).join(rel)
  }

  const manifest = {
    format: FORMAT,
    version: VERSION,
    name: project.name,
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    mediaCount: map.size,
    totalBytes: total
  }

  entries.unshift(
    { name: 'project.json', data: Buffer.from(json, 'utf8') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }
  )

  const zip = buildZip(entries)
  await fsp.mkdir(path.dirname(outPath), { recursive: true })
  await fsp.writeFile(outPath, zip)
  return { outPath, mediaCount: map.size, totalBytes: total, missing }
}

/* ------------------------------------------------------------------ 导入 */

export async function importProjectFromFile(
  zipPath: string,
  projectsDir: string,
  existingNames: string[]
): Promise<ImportResult> {
  const buf = await fsp.readFile(zipPath)
  const entries = readZip(buf)

  const pj = entries.find((e) => e.name === 'project.json')
  if (!pj) throw new Error('不是有效的工程包：缺少 project.json')
  let json = pj.data.toString('utf8')
  let parsed: Project
  try {
    parsed = JSON.parse(json) as Project
  } catch {
    throw new Error('工程包里的 project.json 已损坏，无法解析')
  }

  const id = newId()
  const root = path.join(projectsDir, id)
  const mediaDir = path.join(root, 'media')
  await fsp.mkdir(mediaDir, { recursive: true })

  // 还原媒体
  let mediaCount = 0
  const relToAbs = new Map<string, string>()
  for (const e of entries) {
    if (!e.name.startsWith(`${MARK}/media/`)) continue
    const base = e.name.slice(`${MARK}/media/`.length)
    const abs = path.join(mediaDir, path.basename(base))
    await fsp.writeFile(abs, e.data)
    relToAbs.set(e.name, abs)
    mediaCount += 1
  }

  // 相对路径 → 新机器上的绝对路径
  for (const [rel, abs] of relToAbs) {
    json = json.split(rel).join(jsonEscape(abs))
  }

  const project = JSON.parse(json) as Project
  project.id = id
  project.createdAt = new Date().toISOString()
  project.updatedAt = project.createdAt
  // 重名：加「（导入）」/ 递增序号，绝不覆盖已有工程
  project.name = uniqueName(project.name || parsed.name || '导入工程', existingNames)

  await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify(project, null, 2), 'utf8')
  return { project, mediaCount, restoredDir: root }
}

export function uniqueName(name: string, existing: string[]): string {
  const base = String(name || '工程').trim() || '工程'
  if (!existing.includes(base)) return base
  const first = `${base}（导入）`
  if (!existing.includes(first)) return first
  for (let i = 2; i < 1000; i += 1) {
    const n = `${base}（导入 ${i}）`
    if (!existing.includes(n)) return n
  }
  return `${base}（导入 ${Date.now()}）`
}
