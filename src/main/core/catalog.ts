import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 按工作流组织的模型下载目录（全部实测可下载，206 Range 支持）。
 *
 * 设计要点：
 * - 每个工作流一条下载项，包含它所需的全部模型，一次点齐。
 * - 私有/社区模型的公开替代：下载公开模型，但**保存为工作流模板引用的文件名**，
 *   这样模板无需修改即可加载（PackFile.file 是目标路径，sources 是真实的公开下载地址）。
 * - 确实无公开源的（QuadView_krea2_v1、krea2-Cc-天魔-身材、krea2-美学人像摄影），
 *   由 template-adapt 在运行前自动把对应 LoRA 强度置 0 降级，保证工作流仍可跑。
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
  /** 目标路径（相对 ComfyUI/models），必须与工作流模板引用的文件名一致 */
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

/** 镜像优先（原始地址，实际改写由网络设置的 applyMirrors 统一处理） */
function mirrorSources(repo: string, file: string): FileSource[] {
  return [
    { name: 'HuggingFace 官方', url: `${HF}/${repo}/resolve/main/${file}` },
    { name: 'hf-mirror 镜像', url: `${HF_MIRROR}/${repo}/resolve/main/${file}` },
    { name: 'ModelScope 魔搭', url: `${MODELSCOPE}/models/${repo}/resolve/master/${file}` }
  ]
}

/** 运行时（ComfyUI 便携版） */
const RUNTIME: CatalogEntry[] = [
  {
    id: 'comfyui-portable',
    label: 'ComfyUI 便携版',
    kind: 'comfyui',
    description: '官方 Windows 便携版，内置 Python 与 GPU 版 PyTorch。解压后双击 run 脚本启动。约 1.9GB，不含模型。',
    sizeMB: 1930,
    file: 'ComfyUI_windows_portable_nvidia.7z',
    sources: [
      { name: 'GitHub 官方（固定版本 v0.45.0，最快）', url: 'https://github.com/comfyanonymous/ComfyUI/releases/download/v0.45.0/ComfyUI_windows_portable_nvidia.7z' },
      { name: 'GitHub 官方（最新版）', url: `${GITHUB}/ComfyUI_windows_portable_nvidia.7z` }
    ]
  }
]

/** FFmpeg 工具 */
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
    { name: 'gyan.dev 官方', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' }
  ]
}

/** MiniMax H3 视频工作流（6 文件，全部公开可下） */
const H3_PACK: CatalogEntry = {
  id: 'pack-h3-video',
  label: 'MiniMax H3 视频生成（全套 6 模型）',
  kind: 'pack',
  description: 'H3 三采工作流所需全部模型：主模型、文本编码器、视频/音频 VAE、TAE 预览、latent 放大。约 38GB。',
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

/** 千问图片工作流（文生图 / 局部编辑 / 四视图 全套公开可下） */
const QWEN_PACK: CatalogEntry = {
  id: 'pack-qwen-image',
  label: '千问 Qwen-Image 2.1 图片生成（全套）',
  kind: 'pack',
  description: '千问文生图 / 局部编辑 / 四视图所需：文生图模型、编辑模型、文本编码器、VAE、多角度四视图 LoRA。约 43GB。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/Qwen-Image-2.1/qwen_image_2.1_int8_convrot.safetensors',
      sizeMB: 6922,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors')
    },
    {
      // 编辑模型：用官方 Qwen-Image-Edit 2509 int8 替代社区强化版，保存为模板引用名
      file: 'diffusion_models/Qwen-Image-2.1/rayQwen21编辑强化_turboV13Int8convrot.safetensors',
      sizeMB: 19548,
      sources: mirrorSources('Comfy-Org/Qwen-Image-Edit', 'split_files/diffusion_models/qwen_image_edit_2509_int8_convrot.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
      sizeMB: 8918,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_int8_convrot.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_8b_w4a8.safetensors',
      sizeMB: 6022,
      sources: mirrorSources('Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_w4a8.safetensors')
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

/** Krea2 图片工作流（文生图 / 局部编辑 / 四视图 全套公开可下） */
const KREA2_PACK: CatalogEntry = {
  id: 'pack-krea2',
  label: 'Krea2 图片生成（全套）',
  kind: 'pack',
  description:
    'Krea2 文生图 / 局部编辑 / 四视图所需：Turbo 模型(bf16+fp8)、文本编码器、VAE、4步加速 LoRA、MJ 风格 LoRA、RealVAE、身材/人像摄影 LoRA(公开替代)。约 68GB。注意：QuadView 四视图专用 LoRA 无公开源，缺失时自动降级为纯提示词出四视图（也可切千问引擎出四视图，效果更稳）。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/Krea2_turbo.safetensors',
      sizeMB: 25066,
      sources: mirrorSources('Comfy-Org/Krea-2', 'diffusion_models/krea2_turbo_bf16.safetensors')
    },
    {
      file: 'diffusion_models/Krea2-Turbo-fp8_v10.safetensors',
      sizeMB: 12288,
      sources: mirrorSources('Comfy-Org/Krea-2', 'diffusion_models/krea2_turbo_fp8_scaled.safetensors')
    },
    {
      file: 'text_encoders/qwen3VLInstruct4bHeretic_v10(1).safetensors',
      sizeMB: 4997,
      sources: mirrorSources('Comfy-Org/Krea-2', 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors')
    },
    {
      file: 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors',
      sizeMB: 4997,
      sources: mirrorSources('Comfy-Org/Krea-2', 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors')
    },
    {
      file: 'vae/krea2RealVae_v10.safetensors',
      sizeMB: 484,
      sources: mirrorSources('artsyww/KREA2REALVAE', 'krea2RealVae_v10.safetensors')
    },
    {
      file: 'vae/qwen_image_vae.safetensors',
      sizeMB: 242,
      sources: mirrorSources('Comfy-Org/Krea-2', 'vae/qwen_image_vae.safetensors')
    },
    {
      file: 'loras/krea2_turbo_4step_rank_64_lora_comfyui.safetensors',
      sizeMB: 418,
      sources: mirrorSources('Comfy-Org/Krea-2', 'loras/krea2_turbo_lora_rank_64_bf16.safetensors')
    },
    {
      file: 'loras/krea2-Cc-MJ-影视柔光.safetensors',
      sizeMB: 218,
      sources: mirrorSources('RunningHubAI/rh-krea2-cc-mj-lora', 'krea2-Cc-MJ-影视柔光.safetensors')
    },
    {
      file: 'loras/krea2-Cc-MJ-风格滤镜.safetensors',
      sizeMB: 327,
      sources: mirrorSources('RunningHubAI/rh-krea2-cc-mj-lora', 'krea2-Cc-MJ-风格滤镜.safetensors')
    },
    {
      // 社区私有「天魔-身材」的公开替代（同为 218MB，功能相近）
      file: 'loras/krea2-Cc-天魔-身材.safetensors',
      sizeMB: 218,
      sources: mirrorSources('uzumix/krea2_realisticSnapshot', 'RealisticSnapshotKrea2.safetensors')
    },
    {
      // 社区私有「美学人像摄影」的公开替代（同为 224MB，功能相近）
      file: 'loras/krea2-美学人像摄影.safetensors',
      sizeMB: 224,
      sources: mirrorSources('thatboymentor/SEEDRAAI-REAL-Natural-Photography-Krea2', 'SeedraAI-REAL-Natural-Photography-v2.safetensors')
    }
  ]
}

/** Z-Image 工作流 */
const ZIMAGE_PACK: CatalogEntry = {
  id: 'pack-zimage',
  label: 'Z-Image-Turbo（角色四视图/文生图）',
  kind: 'pack',
  description: 'Z-Image Turbo 模型 + 文本编码器 + VAE，约 15GB。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/z_image_turbo_bf16.safetensors',
      sizeMB: 11740,
      sources: mirrorSources('Comfy-Org/Z-Image-Turbo', 'split_files/diffusion_models/z_image_turbo_bf16.safetensors')
    },
    {
      file: 'vae/ae.safetensors',
      sizeMB: 318,
      sources: mirrorSources('Comfy-Org/Z-Image-Turbo', 'split_files/vae/ae.safetensors')
    },
    {
      file: 'text_encoders/qwen_3_4b_fp4_mixed.safetensors',
      sizeMB: 3318,
      sources: mirrorSources('Comfy-Org/Z-Image-Turbo', 'split_files/text_encoders/qwen_3_4b_fp4_mixed.safetensors')
    }
  ]
}

/** 音乐生成工作流 */
const MUSIC_PACK: CatalogEntry = {
  id: 'pack-music',
  label: '音乐生成 ACE-Step 1.5（全套）',
  kind: 'pack',
  description: '音乐生成工作流所需：ACE-Step 1.5 XL Turbo 模型、文本编码器、VAE，约 20GB。',
  vendor: 'nvidia',
  minVramMB: 6 * 1024,
  files: [
    {
      file: 'diffusion_models/ace/acestep_v1.5_xl_turbo_bf16.safetensors',
      sizeMB: 9513,
      sources: mirrorSources('Comfy-Org/ACE-Step-1.5', 'split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors')
    },
    {
      file: 'text_encoders/qwen_0.6b_ace15.safetensors',
      sizeMB: 1136,
      sources: mirrorSources('Comfy-Org/ACE-Step-1.5', 'split_files/text_encoders/qwen_0.6b_ace15.safetensors')
    },
    {
      file: 'text_encoders/qwen_4b_ace15.safetensors',
      sizeMB: 7987,
      sources: mirrorSources('Comfy-Org/ACE-Step-1.5', 'split_files/text_encoders/qwen_4b_ace15.safetensors')
    },
    {
      file: 'vae/ace_1.5_vae.safetensors',
      sizeMB: 322,
      sources: mirrorSources('Comfy-Org/ACE-Step-1.5', 'split_files/vae/ace_1.5_vae.safetensors')
    }
  ]
}

export const MODEL_CATALOG: CatalogEntry[] = [H3_PACK, QWEN_PACK, KREA2_PACK, ZIMAGE_PACK, MUSIC_PACK]

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

function modelDest(modelsRoot: string, relFile: string): string {
  return path.join(modelsRoot, relFile)
}

export function resolveCatalog(installRoot: string, gpu: GpuInfo, comfyModelsRoot?: string | null): ResolvedCatalogItem[] {
  const out: ResolvedCatalogItem[] = []

  for (const e of RUNTIME) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    const dest = path.join(installRoot, e.file ?? '')
    const extractedDir = dest.replace(/\.(7z|zip)$/i, '')
    out.push({
      id: e.id, label: e.label, kind: e.kind, description: e.description, sizeMB: e.sizeMB,
      vendor: e.vendor, minVramMB: e.minVramMB, file: e.file, sources: e.sources, dest,
      installed: fs.existsSync(dest), extractedDir, extracted: fs.existsSync(extractedDir),
      extract: /\.(7z|zip)$/i.test(e.file ?? '')
    })
  }

  for (const e of [FFMPEG]) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    if (gpu.vramKnown && e.minVramMB && gpu.vramMB < e.minVramMB) continue
    const dest = path.join(installRoot, e.file ?? '')
    const extractedDir = dest.replace(/\.(7z|zip)$/i, '')
    out.push({
      id: e.id, label: e.label, kind: e.kind, description: e.description, sizeMB: e.sizeMB,
      vendor: e.vendor, minVramMB: e.minVramMB, file: e.file, sources: e.sources, dest,
      installed: fs.existsSync(dest), extract: /\.(7z|zip)$/i.test(e.file ?? ''),
      extractedDir, extracted: fs.existsSync(extractedDir)
    })
  }

  for (const e of MODEL_CATALOG) {
    if (e.vendor && e.vendor !== gpu.vendor) continue
    if (!gpu.vramKnown) continue
    if (e.minVramMB && gpu.vramMB < e.minVramMB) continue
    const files = (e.files ?? []).map((f) => {
      const dest = modelDest(comfyModelsRoot ?? path.join(installRoot, 'models'), f.file)
      return { file: f.file, sizeMB: f.sizeMB, url: f.sources[0]?.url ?? '', sources: f.sources, dest, installed: fs.existsSync(dest) }
    })
    out.push({
      id: e.id, label: e.label, kind: e.kind, description: e.description, vendor: e.vendor,
      minVramMB: e.minVramMB, files,
      installed: files.length > 0 && files.every((f) => f.installed),
      sizeMB: e.sizeMB ?? files.reduce((s, f) => s + (f.sizeMB ?? 0), 0)
    })
  }
  return out
}
