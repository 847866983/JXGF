import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 按工作流组织的模型下载目录。
 * 每个工作流是一条下载项，包含它所需的全部模型文件，一次点击全部下载。
 * 所有源默认镜像优先（hf-mirror 国内镜像在前），多线程分块下载。
 */

const GITHUB = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download'
const HF = 'https://huggingface.co'
const HF_MIRROR = 'https://hf-mirror.com'
const MODELSCOPE = 'https://modelscope.cn'

export type CatalogKind = 'comfyui' | 'tool' | 'pack'

export interface FileSource {
  name: string
  url: string
}

export interface PackFile {
  /** 相对 models 的子目录 + 文件名，如 vae/xxx.safetensors；tool 类为包名 */
  file: string
  sizeMB?: number
  sources: FileSource[]
}

export interface CatalogEntry {
  id: string
  label: string
  kind: CatalogKind
  description: string
  /** 总大小（MB，汇总各文件） */
  sizeMB?: number
  vendor?: 'nvidia' | 'amd'
  minVramMB?: number
  /** 工作流包：包含多个模型文件 */
  files?: PackFile[]
  /** 单文件条目（旧式，如 ComfyUI 便携版 / FFmpeg） */
  file?: string
  sources?: FileSource[]
}

/** 镜像优先：HF 官方镜像在前 */
function mirrorSources(repo: string, file: string): FileSource[] {
  return [
    { name: 'hf-mirror 镜像', url: `${HF_MIRROR}/${repo}/resolve/main/${file}` },
    { name: 'HuggingFace 官方', url: `${HF}/${repo}/resolve/main/${file}` },
    { name: 'ModelScope 魔搭', url: `${MODELSCOPE}/models/${repo}/resolve/master/${file}` }
  ]
}

/** 运行时（ComfyUI 便携版） */
const RUNTIME: CatalogEntry[] = [
  {
    id: 'comfyui-portable',
    label: 'ComfyUI 便携版',
    kind: 'comfyui',
    description: '官方 Windows 便携版，内置 Python 与 GPU 版 PyTorch。下载后解压、双击 run 脚本启动。约 2.5GB，不含模型。',
    sizeMB: 2500,
    file: 'ComfyUI_windows_portable_nvidia.7z',
    sources: [
      { name: 'gh-proxy 镜像', url: `https://gh-proxy.com/${GITHUB}/ComfyUI_windows_portable_nvidia.7z` },
      { name: 'GitHub 官方', url: `${GITHUB}/ComfyUI_windows_portable_nvidia.7z` }
    ]
  }
]

/** FFmpeg 工具（视频合成必需） */
const FFMPEG: CatalogEntry = {
  id: 'ffmpeg-essentials',
  label: 'FFmpeg（视频合成）',
  kind: 'tool',
  description: 'BanZhang 视频合成依赖 ffmpeg/ffprobe。解压后把 bin 目录加入 PATH，或放到 ComfyUI/custom_nodes/.../tools/ffmpeg/bin。',
  sizeMB: 110,
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  file: 'ffmpeg-release-essentials.zip',
  sources: [
    { name: 'gh-proxy 镜像', url: 'https://gh-proxy.com/https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' },
    { name: 'gyan.dev 官方', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' }
  ]
}

/** MiniMax H3 视频工作流：6 个模型文件 */
const H3_PACK: CatalogEntry = {
  id: 'pack-h3-video',
  label: 'MiniMax H3 视频生成（全套）',
  kind: 'pack',
  description: 'H3 三采工作流所需全部模型：主模型、文本编码器、视频/音频 VAE、TAE 预览、latent 放大。一次下载约 38GB，多线程镜像下载。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'MiniMax-H3/minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors',
      sizeMB: 20000,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'minimax_h3_hybrid_fl2va_ref2va_b25-49.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_32b_minimax_h3-w4a8_convrot.safetensors',
      sizeMB: 15000,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'qwen3vl_32b_minimax_h3-w4a8_convrot.safetensors')
    },
    {
      file: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
      sizeMB: 2700,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'minimax_h3_video_vae_int8_convrot.safetensors')
    },
    {
      file: 'vae/minimax_h3_audio_vae_fp32.safetensors',
      sizeMB: 580,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'minimax_h3_audio_vae_fp32.safetensors')
    },
    {
      file: 'vae_approx/MiniMax-H3-TAE.safetensors',
      sizeMB: 9,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'MiniMax-H3-TAE.safetensors')
    },
    {
      file: 'latent_upscale_models/h3_upscaler_lms_v0.1.safetensors',
      sizeMB: 660,
      sources: mirrorSources('MiniMax/MiniMax-H3', 'h3_upscaler_lms_v0.1.safetensors')
    }
  ]
}

/** 千问图片工作流：文生图模型 + 文本编码器 + VAE + 多角度 LoRA */
const QWEN_PACK: CatalogEntry = {
  id: 'pack-qwen-image',
  label: '千问 Qwen-Image 2.1 图片生成（全套）',
  kind: 'pack',
  description: '千问文生图与四视图工作流所需：文生图模型、文本编码器、VAE、多角度四视图 LoRA。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
      sizeMB: 8000,
      sources: mirrorSources('Qwen/Qwen-Image-2.1', 'qwen_image_2.1_int8_convrot.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
      sizeMB: 8900,
      sources: mirrorSources('Qwen/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_int8_convrot.safetensors')
    },
    {
      file: 'vae/qwen_image_2.1_vae_bf16.safetensors',
      sizeMB: 620,
      sources: mirrorSources('Qwen/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors')
    },
    {
      file: 'loras/qwen21_multiple_angles_v2.safetensors',
      sizeMB: 304,
      sources: mirrorSources('akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA', 'checkpoints_v2/angles_v2_full_qwen21_multiple_angles_v2_qwen21_multiple_angles_v2_000001500.safetensors')
    }
  ]
}

/** Krea2 工作流：模型 + QuadView 四视图 LoRA */
const KREA2_PACK: CatalogEntry = {
  id: 'pack-krea2',
  label: 'Krea2 图片生成（全套）',
  kind: 'pack',
  description: 'Krea2 文生图与四视图工作流所需：Krea2 模型、四视图 LoRA。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/Krea2-Turbo-fp8_v10.safetensors',
      sizeMB: 4000,
      sources: mirrorSources('Comfy-Org/Krea2', 'Krea2-Turbo-fp8_v10.safetensors')
    },
    {
      file: 'loras/QuadView_krea2_v1.safetensors',
      sizeMB: 50,
      sources: mirrorSources('Comfy-Org/Krea2', 'QuadView_krea2_v1.safetensors')
    }
  ]
}

/** Z-Image 角色四视图 */
const ZIMAGE_PACK: CatalogEntry = {
  id: 'pack-zimage',
  label: 'Z-Image-Turbo（角色四视图/文生图）',
  kind: 'pack',
  description: '阿里通义 Z-Image Turbo 模型（约 11.5GB）。角色四视图、文生图首选。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/z_image_turbo_bf16.safetensors',
      sizeMB: 11780,
      sources: mirrorSources('Tongyi-MAI/Z-Image-Turbo', 'z_image_turbo_bf16.safetensors')
    }
  ]
}

export const MODEL_CATALOG: CatalogEntry[] = [H3_PACK, QWEN_PACK, KREA2_PACK, ZIMAGE_PACK]

export const ALL_ENTRIES: CatalogEntry[] = [...RUNTIME, FFMPEG, ...MODEL_CATALOG]

export interface ResolvedPackFile {
  file: string
  sizeMB?: number
  /** 完整下载 URL（默认取第一个镜像源） */
  url: string
  sources: FileSource[]
  dest: string
  installed: boolean
}

export interface ResolvedCatalogItem {
  id: string
  label: string
  kind: CatalogKind
  description: string
  sizeMB?: number
  vendor?: 'nvidia' | 'amd'
  minVramMB?: number
  /** 工作流包的文件清单（已解析 dest / installed） */
  files?: ResolvedPackFile[]
  /** 单文件条目 */
  file?: string
  sources?: FileSource[]
  dest?: string
  installed: boolean
  extractedDir?: string
  extracted?: boolean
  extract?: boolean
}

/** 把 ComfyUI models 根 + 相对路径拼成目标路径 */
function modelDest(modelsRoot: string, relFile: string): string {
  return path.join(modelsRoot, relFile)
}

export function resolveCatalog(installRoot: string, gpu: GpuInfo, comfyModelsRoot?: string | null): ResolvedCatalogItem[] {
  const out: ResolvedCatalogItem[] = []

  // 运行时
  for (const e of RUNTIME) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    const dest = path.join(installRoot, e.file ?? '')
    const extractedDir = dest.replace(/\.(7z|zip)$/i, '')
    out.push({
      id: e.id,
      label: e.label,
      kind: e.kind,
      description: e.description,
      sizeMB: e.sizeMB,
      vendor: e.vendor,
      minVramMB: e.minVramMB,
      file: e.file,
      sources: e.sources,
      dest,
      installed: fs.existsSync(dest),
      extractedDir,
      extracted: fs.existsSync(extractedDir),
      extract: /\.(7z|zip)$/i.test(e.file ?? '')
    })
  }

  // 工具
  for (const e of [FFMPEG]) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    if (gpu.vramKnown && e.minVramMB && gpu.vramMB < e.minVramMB) continue
    const dest = path.join(installRoot, e.file ?? '')
    const extractedDir = dest.replace(/\.(7z|zip)$/i, '')
    out.push({
      id: e.id,
      label: e.label,
      kind: e.kind,
      description: e.description,
      sizeMB: e.sizeMB,
      vendor: e.vendor,
      minVramMB: e.minVramMB,
      file: e.file,
      sources: e.sources,
      dest,
      installed: fs.existsSync(dest),
      extract: /\.(7z|zip)$/i.test(e.file ?? ''),
      extractedDir,
      extracted: fs.existsSync(extractedDir)
    })
  }

  // 工作流包
  for (const e of MODEL_CATALOG) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    if (!gpu.vramKnown) continue
    if (e.minVramMB && gpu.vramMB < e.minVramMB) continue
    const files = (e.files ?? []).map((f) => {
      const dest = modelDest(comfyModelsRoot ?? path.join(installRoot, 'models'), f.file)
      return {
        file: f.file,
        sizeMB: f.sizeMB,
        url: f.sources[0]?.url ?? '',
        sources: f.sources,
        dest,
        installed: fs.existsSync(dest)
      }
    })
    out.push({
      id: e.id,
      label: e.label,
      kind: e.kind,
      description: e.description,
      vendor: e.vendor,
      minVramMB: e.minVramMB,
      files,
      installed: files.length > 0 && files.every((f) => f.installed),
      sizeMB: e.sizeMB ?? files.reduce((s, f) => s + (f.sizeMB ?? 0), 0)
    })
  }
  return out
}
