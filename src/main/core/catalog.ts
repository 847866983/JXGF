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

/** 通用：给某个模型条目生成 HF 官方 + hf-mirror + ModelScope 三源 */
function hfSources(repo: string, file: string): { name: string; url: string }[] {
  return [
    { name: 'HuggingFace 官方', url: `${HF}/${repo}/resolve/main/${file}` },
    { name: 'hf-mirror 国内镜像', url: `${HF_MIRROR}/${repo}/resolve/main/${file}` },
    { name: 'ModelScope 魔搭', url: `${MODELSCOPE}/models/${repo}/resolve/master/${file}` }
  ]
}

/**
 * 视频/图片模型目录：按显存档位推荐。file 指向 ComfyUI 的 models/<子目录>/文件名，
 * dest 由 resolveCatalog 按 kind 计算（模型 = installRoot/models/...）。
 */
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
    sources: hfSources(WAN_REPO, WAN_FILE)
  },
  {
    id: 'z-image-turbo',
    label: 'Z-Image-Turbo（角色四视图/文生图）',
    kind: 'model',
    description: '阿里通义 Z-Image Turbo 扩散模型（约 11.5GB）。角色四视图、文生图首选。放到 models/diffusion_models。',
    sizeMB: 11780,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'z_image_turbo_bf16.safetensors',
    sources: hfSources('Tongyi-MAI/Z-Image-Turbo', 'z_image_turbo_bf16.safetensors')
  },
  {
    id: 'qwen-image-21-vae',
    label: 'Qwen-Image-2.1 VAE',
    kind: 'model',
    description: 'Qwen-Image 2.1 配套 VAE（约 0.6GB）。放到 models/vae。',
    sizeMB: 620,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'vae/qwen_image_2.1_vae_bf16.safetensors',
    sources: hfSources('Qwen/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors')
  },
  {
    id: 'qwen-image-21-te',
    label: 'Qwen-Image-2.1 文本编码器（Qwen3-VL 8B）',
    kind: 'model',
    description: 'Qwen-Image 2.1 配套文本编码器（约 8.7GB）。放到 models/text_encoders。',
    sizeMB: 8900,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
    sources: hfSources('Qwen/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_int8_convrot.safetensors')
  },
  // ---------- MiniMax H3 视频生成必需模型（6 个，约 38GB） ----------
  {
    id: 'h3-unet',
    label: 'MiniMax H3 主模型（UNET hybrid fl2va/ref2va）',
    kind: 'model',
    description: 'MiniMax H3 视频生成主模型（约 20GB）。放到 models/MiniMax-H3。',
    sizeMB: 20000,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'MiniMax-H3/minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors')
  },
  {
    id: 'h3-clip',
    label: 'MiniMax H3 文本编码器（Qwen3-VL 32B）',
    kind: 'model',
    description: 'MiniMax H3 配套文本编码器（约 15GB）。放到 models/text_encoders。',
    sizeMB: 15000,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'text_encoders/qwen3vl_32b_minimax_h3-w4a8_convrot.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'qwen3vl_32b_minimax_h3-w4a8_convrot.safetensors')
  },
  {
    id: 'h3-video-vae',
    label: 'MiniMax H3 视频 VAE',
    kind: 'model',
    description: 'MiniMax H3 视频 VAE（约 2.7GB）。放到 models/vae。',
    sizeMB: 2700,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'minimax_h3_video_vae_int8_convrot.safetensors')
  },
  {
    id: 'h3-audio-vae',
    label: 'MiniMax H3 音频 VAE',
    kind: 'model',
    description: 'MiniMax H3 音频 VAE（约 0.6GB）。放到 models/vae。',
    sizeMB: 580,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'vae/minimax_h3_audio_vae_fp32.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'minimax_h3_audio_vae_fp32.safetensors')
  },
  {
    id: 'h3-tae',
    label: 'MiniMax H3 TAE（预览 VAE）',
    kind: 'model',
    description: 'MiniMax H3 预览用 TAE（约 9MB）。放到 models/vae_approx。',
    sizeMB: 9,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'vae_approx/MiniMax-H3-TAE.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'MiniMax-H3-TAE.safetensors')
  },
  {
    id: 'h3-upscaler',
    label: 'H3 latent 放大模型',
    kind: 'model',
    description: 'H3 latent 放大模型（约 0.66GB）。放到 models/latent_upscale_models。',
    sizeMB: 660,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'latent_upscale_models/h3_upscaler_lms_v0.1.safetensors',
    sources: hfSources('MiniMax/MiniMax-H3', 'h3_upscaler_lms_v0.1.safetensors')
  },
  // ---------- 图像生成辅助 ----------
  {
    id: 'ffmpeg-essentials',
    label: 'FFmpeg（视频合成必需）',
    kind: 'tool',
    description: 'BanZhang 视频合成依赖 ffmpeg/ffprobe。解压后把 bin 目录加入 PATH，或放到 ComfyUI/custom_nodes/.../tools/ffmpeg/bin。',
    sizeMB: 110,
    vendor: 'nvidia',
    minVramMB: 6 * 1024,
    file: 'ffmpeg-release-essentials.zip',
    sources: [
      { name: 'gyan.dev 官方', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' },
      { name: 'gh-proxy 镜像', url: 'https://gh-proxy.com/https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' }
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

export function resolveCatalog(installRoot: string, gpu: GpuInfo, comfyModelsRoot?: string | null): ResolvedCatalogItem[] {
  const runtimes = CATALOG.filter((e) => !e.vendor || e.vendor === gpu.vendor)
  const models = MODEL_CATALOG.filter((m) => {
    if (m.vendor && m.vendor !== gpu.vendor) return false
    if (!gpu.vramKnown) return false
    return m.minVramMB === undefined || gpu.vramMB >= m.minVramMB
  })
  return [...runtimes, ...models].map((e) => {
    // 模型：优先放到 ComfyUI 的 models/<子目录>，否则放 runtime/models
    const rel = e.kind === 'model' ? path.join('models', e.file) : e.file
    const dest =
      e.kind === 'model' && comfyModelsRoot
        ? path.join(comfyModelsRoot, e.file) // e.file 已含子目录，如 vae/xxx.safetensors
        : path.join(installRoot, rel)
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
