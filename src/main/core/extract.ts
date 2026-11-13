import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export interface ExtractResult {
  dest: string
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function candidateExists(c: string): boolean {
  try {
    return fs.existsSync(c)
  } catch {
    return false
  }
}

function find7z(): string | null {
  const candidates = [
    process.env.FRAMEFORGE_7Z,
    '7z.exe',
    '7za.exe',
    path.join(process.cwd(), 'runtime', 'tools', '7za.exe'),
    path.join(process.resourcesPath ?? '', 'runtime', 'tools', '7za.exe')
  ].filter((c): c is string => Boolean(c))
  for (const c of candidates) {
    // 绝对/相对路径先查存在性；裸命令名交给 execFile 走 PATH 探测
    if (c.includes(path.sep) || c.includes('/')) {
      if (candidateExists(c)) return c
    } else {
      return c
    }
  }
  return null
}

/**
 * 解压下载产物：
 * - .zip 用 Windows 自带 PowerShell Expand-Archive（无额外依赖）
 * - .7z  用 7-Zip（7z.exe / 7za.exe，可用 FRAMEFORGE_7Z 指定，或放 runtime/tools）
 * 目标目录自动创建；超时 zip 30 分钟、7z 60 分钟。
 */
export async function extractArchive(archive: string, dest: string, sevenZip?: string): Promise<ExtractResult> {
  const stat = await fsp.stat(archive).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`找不到待解压文件：${archive}`)
  await fsp.mkdir(dest, { recursive: true })
  const ext = path.extname(archive).toLowerCase()

  if (ext === '.zip') {
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(dest)} -Force`
        ],
        { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
      )
    } catch (err) {
      throw new Error(`zip 解压失败：${String((err as Error).message ?? err)}`)
    }
    return { dest }
  }

  if (ext === '.7z') {
    const bin = sevenZip ?? find7z()
    if (!bin) {
      throw new Error('未找到 7z 解压工具：请安装 7-Zip，或把 7za.exe 放到应用 runtime/tools 目录')
    }
    if (!candidateExists(bin) && (bin.includes(path.sep) || bin.includes('/'))) {
      throw new Error(`7z 解压工具不存在：${bin}`)
    }
    try {
      await execFileAsync(bin, ['x', '-y', `-o${dest}`, archive], {
        timeout: 60 * 60 * 1000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      })
    } catch (err) {
      throw new Error(`7z 解压失败：${String((err as Error).message ?? err)}`)
    }
    return { dest }
  }

  throw new Error(`不支持的压缩格式：${ext || '(无扩展名)'}`)
}
