import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { app } from 'electron'
import { extractArchive } from './extract'

/**
 * 内置 BanZhang 自定义节点包：安装 ComfyUI 后自动解压到 custom_nodes。
 *
 * 节点包随软件分发（resources/comfy-nodes/ComfyUI-Banzhang-All.zip，已剔除 ffmpeg 残片、
 * 语义桥大模型、__pycache__），避免用户装完 ComfyUI 后还要去官网找节点。
 */

/** 节点包在本机的位置（开发态 / 打包态） */
function bundledZipPath(): string {
  const dev = path.join(process.cwd(), 'resources', 'comfy-nodes', 'ComfyUI-Banzhang-All.zip')
  if (fs.existsSync(dev)) return dev
  return path.join(process.resourcesPath ?? app.getAppPath(), 'comfy-nodes', 'ComfyUI-Banzhang-All.zip')
}

export interface NodePackStatus {
  available: boolean
  zipPath: string
  installed: boolean
  installedDir: string
  sizeMB: number
}

/** 检查节点包状态（是否已解压到 ComfyUI/custom_nodes） */
export async function nodePackStatus(comfyRoot: string): Promise<NodePackStatus> {
  const zipPath = bundledZipPath()
  const installedDir = path.join(comfyRoot, 'custom_nodes', 'ComfyUI-Banzhang-All-1101')
  let sizeMB = 0
  try {
    sizeMB = Math.round((await fsp.stat(zipPath)).size / 1024 / 1024)
  } catch {
    // zip 不存在
  }
  return {
    available: fs.existsSync(zipPath),
    zipPath,
    installed: fs.existsSync(path.join(installedDir, '__init__.py')) || fs.existsSync(installedDir),
    installedDir,
    sizeMB
  }
}

/**
 * 把内置节点包解压到 ComfyUI/custom_nodes。
 * 已安装则跳过；返回安装目录。
 */
export async function installNodePack(comfyRoot: string): Promise<{ installedDir: string; skipped: boolean }> {
  const status = await nodePackStatus(comfyRoot)
  if (!status.available) throw new Error('未找到内置节点包（comfy-nodes/ComfyUI-Banzhang-All.zip）')
  if (status.installed) return { installedDir: status.installedDir, skipped: true }
  const customNodes = path.join(comfyRoot, 'custom_nodes')
  await fsp.mkdir(customNodes, { recursive: true })
  await extractArchive(status.zipPath, customNodes)
  return { installedDir: status.installedDir, skipped: false }
}
