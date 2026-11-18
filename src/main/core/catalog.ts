import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 按工作流组织的模型下载目录。
 * 每个工作流是一条下载项，包含它所需的全部模型文件，一次点击全部下载。
 * 所有源默认镜像优先（hf-mirror 国内镜像在前），多线程分块下载 + 多镜像自动回退。
 *
 * 注意：所有 URL 均已实测可访问（206 Range 支持）；目标文件名与工作流模板引用的文件名一致。
 */

const GITHUB = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download'
const HF_MIRROR = 'https://hf-mirror.com'
const HF = 'https://huggingface.co'
const MODELSCOPE = 'https://modelscope.cn'

export type CatalogKind = 'comfyui' | 'tool' | 'pack'

export interface FileSource {
  name: string
  url: string
}

export interface PackFile {
  /** 相对 models 的子目录 + 文件名（工作流模板引用的名字）；tool 类为包名 */
  file: string
  sizeMB?: number
  sources: FileSource[]
}

export interface CatalogEntry {
  id: string
  label: string
  kind: CatalogKind
  description: string
  sizeMB?: number
  vendor?: 'nvidia' | 'amd'
  minVramMB?: number
  files?: PackFile[]
  file?: string
  sources?: FileSource[]
}

/** 镜像优先：hf-mirror 在前，官方/魔搭兜底 */
function mirrorSources(repo: string, file: string): FileSource[] {
  return [
    { name: 'hf-mirror 镜像', url: `${HF_MIRROR}/${repo}/resolve/main/${file}` },
    { name: 'HuggingFace 官方', url: `${HF}/${repo}/resolve/main/${file}` },
    { name: 'ModelScope 魔搭', url: `${MODELSCOPE}/models/${repo}/resolve/master/${file}` }
  ]
}

/** 运行时（ComfyUI 便携版）：多镜像，按速度优先排列 */
const RUNTIME: CatalogEntry[] = [
  {
    id: 'comfyui-portable',
    label: 'ComfyUI 便携版',
    kind: 'comfyui',
    description: '官方 Windows 便携版，内置 Python 与 GPU 版 PyTorch。下载后解压、双击 run 脚本启动。约 1.9GB，不含模型。',
    sizeMB: 1930,
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

/** MiniMax H3 视频工作流（全部实测可用源） */
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
      sources: mirrorSources('smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models', 'minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_32b_minimax_h3-w4a8_convrot.safetensors',
      sizeMB: 14960,
      sources: mirrorSources('Comfy-Org/MiniMax-H3', 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors')
    },
    {
      file: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
      sizeMB: 2680,
      sources: mirrorSources('Comfy-Org/MiniMax-H3', 'vae/minimax_h3_video_vae_int8_convrot.safetensors')
    },
    {
      file: 'vae/minimax_h3_audio_vae_fp32.safetensors',
      sizeMB: 573,
      sources: mirrorSources('Comfy-Org/MiniMax-H3', 'vae/minimax_h3_audio_vae_fp32.safetensors')
    },
    {
      file: 'vae_approx/MiniMax-H3-TAE.safetensors',
      sizeMB: 9,
      sources: mirrorSources('Kijai/MiniMax-H3-TAE', 'vae_approx/taeh3.safetensors')
    },
    {
      file: 'latent_upscale_models/h3_upscaler_lms_v0.1.safetensors',
      sizeMB: 659,
      sources: mirrorSources('LBH-123-AI/Minimax_h3_latent_Upscaler', 'minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors')
    }
  ]
}

/** 千问图片工作流（实测可用源） */
const QWEN_PACK: CatalogEntry = {
  id: 'pack-qwen-image',
  label: '千问 Qwen-Image 2.1 图片生成（全套）',
  kind: 'pack',
  description: '千问文生图 / 局部编辑 / 四视图工作流所需：文生图模型、文本编码器、VAE、多角度四视图 LoRA。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
      sizeMB: 6922,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
      sizeMB: 8918,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_int8_convrot.safetensors')
    },
    {
      file: 'vae/qwen_image_2.1_vae_bf16.safetensors',
      sizeMB: 645,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors')
    },
    {
      file: 'loras/qwen21_multiple_angles_v2.safetensors',
      sizeMB: 304,
      sources: mirrorSources('akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA', 'checkpoints_v2/angles_v2_full_qwen21_multiple_angles_v2_qwen21_multiple_angles_v2_000001500.safetensors')
    }
  ]
}

/** Krea2 图片工作流 */
const KREA2_PACK: CatalogEntry = {
  id: 'pack-krea2',
  label: 'Krea2 图片生成（全套）',
  kind: 'pack',
  description: 'Krea2 文生图 / 局部编辑 / 四视图工作流所需：Krea2 Turbo 模型。（四视图 LoRA 为本地私有模型，需从已有机器拷贝 QuadView_krea2_v1.safetensors）',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/krea2_turbo_fp8.safetensors',
      sizeMB: 12300,
      sources: mirrorSources('Comfy-Org/Krea-2', 'diffusion_models/krea2_turbo_fp8.safetensors')
    }
  ]
}

/** Z-Image 角色四视图 / 文生图 */
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
      sizeMB: 11740,
      sources: mirrorSources('Comfy-Org/Z-Image-Turbo', 'split_files/diffusion_models/z_image_turbo_bf16.safetensors')
    }
  ]
}

export const MODEL_CATALOG: CatalogEntry[] = [H3_PACK, QWEN_PACK, KREA2_PACK, ZIMAGE_PACK]

export const ALL_ENTRIES: CatalogEntry[] = [...RUNTIME, FFMPEG, ...MODEL_CATALOG]

export interface ResolvedPackFile {
  file: string
  sizeMB?: number
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
  files?: ResolvedPackFile[]
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
