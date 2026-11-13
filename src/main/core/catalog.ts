import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 可下载组件目录：ComfyUI 便携版 + 视频模型。
 * 每项支持多镜像源（GitHub / HF 官方 + 国内镜像），
 * 由 DownloadManager 断点续传 + SHA256 校验（模型条目可补 sha256）。
 */

const GITHUB = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download'
const HF = 'https://huggingface.co'
const HF_MIRROR = 'https://hf-mirror.com'
const MODELSCOPE = 'https://modelscope.cn'

export type CatalogKind = 'comfyui' | 'tool' | 'model'

export interface CatalogEntry {
  id: string
  label: string
  kind: CatalogKind
  description: string
  sizeMB?: number
  /** 限定显卡厂商；不填表示所有厂商可用 */
  vendor?: 'nvidia' | 'amd'
  /** 模型最低显存（MB），低于该档位不推荐下载 */
  minVramMB?: number
  file: string
  sources: { name: string; url: string }[]
  sha256?: string
}

/** 运行端（ComfyUI 便携版） */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'comfyui-portable-nvidia',
    label: 'ComfyUI 便携版（NVIDIA）',
    kind: 'comfyui',
    description: '官方 Windows 便携版，内置 Python 与 NVIDIA 版 PyTorch。下载后解压，双击 run_nvidia_gpu.bat 启动。',
    sizeMB: 2500,
    vendor: 'nvidia',
    file: 'ComfyUI_windows_portable_nvidia.7z',
    sources: [
      { name: 'GitHub 官方', url: `${GITHUB}/ComfyUI_windows_portable_nvidia.7z` },
      { name: 'gh-proxy 镜像', url: `https://gh-proxy.com/${GITHUB}/ComfyUI_windows_portable_nvidia.7z` }
    ]
  },
  {
    id: 'comfyui-portable-amd',
    label: 'ComfyUI 便携版（AMD）',
    kind: 'comfyui',
    description: '官方 Windows 便携版（AMD GPU）。下载后解压，双击 run_amd_gpu.bat 启动。',
    sizeMB: 2500,
    vendor: 'amd',
    file: 'ComfyUI_windows_portable_amd.7z',
    sources: [
      { name: 'GitHub 官方', url: `${GITHUB}/ComfyUI_windows_portable_amd.7z` },
      { name: 'gh-proxy 镜像', url: `https://gh-proxy.com/${GITHUB}/ComfyUI_windows_portable_amd.7z` }
    ]
  }
]

const WAN_REPO = 'Comfy-Org/Wan_2.1_ComfyUI_repackaged'
const WAN_FILE = 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors'

/** 视频模型目录：按显存档位推荐，三个下载源（HF 官方 + hf-mirror + ModelScope） */
export const MODEL_CATALOG: CatalogEntry[] = [
  {
    id: 'wan21-t2v-13b',
    label: 'Wan 2.1 文生视频 1.3B（fp16）',
    kind: 'model',
    description: '轻量文生视频模型，约 2.7GB，6GB 显存入门档可用。下载后放入 ComfyUI 的 models/diffusion_models 目录。',
    sizeMB: 2707,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'wan2.1_t2v_1.3B_fp16.safetensors',
    sources: [
      { name: 'HuggingFace 官方', url: `${HF}/${WAN_REPO}/resolve/main/${WAN_FILE}` },
      { name: 'hf-mirror 国内镜像', url: `${HF_MIRROR}/${WAN_REPO}/resolve/main/${WAN_FILE}` },
      { name: 'ModelScope 魔搭', url: `${MODELSCOPE}/models/${WAN_REPO}/resolve/master/${WAN_FILE}` }
    ]
  }
]

export interface ResolvedCatalogItem extends CatalogEntry {
  dest: string
  installed: boolean
  extractedDir: string
  extracted: boolean
  /** 是否为压缩包（需要解压步骤） */
  extract: boolean
}

export function resolveCatalog(installRoot: string, gpu: GpuInfo): ResolvedCatalogItem[] {
  const runtimes = CATALOG.filter((e) => !e.vendor || e.vendor === gpu.vendor)
  const models = MODEL_CATALOG.filter((m) => {
    if (m.vendor && m.vendor !== gpu.vendor) return false
    if (!gpu.vramKnown) return false
    return m.minVramMB === undefined || gpu.vramMB >= m.minVramMB
  })
  return [...runtimes, ...models].map((e) => {
    const rel = e.kind === 'model' ? path.join('models', e.file) : e.file
    const dest = path.join(installRoot, rel)
    const isArchive = /\.(7z|zip)$/i.test(e.file)
    const extractedDir = isArchive ? dest.replace(/\.(7z|zip)$/i, '') : dest
    const installed = fs.existsSync(dest)
    return {
      ...e,
      dest,
      installed,
      extractedDir,
      extracted: isArchive ? fs.existsSync(extractedDir) : installed,
      extract: isArchive
    }
  })
}
