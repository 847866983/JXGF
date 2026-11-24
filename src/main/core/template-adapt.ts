import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 按本机显存自动适配工作流模板（H3 三采的 节点包放大 / 稀疏注意力 / 显存守卫）。
 *
 * 背景：H3 模板按 12GB 显存配置。放大节点加载真实放大模型
 *   minimax_h3_latent_upscaler_3d_bf16.safetensors（约 659MB）在低显存卡上会 OOM。
 *
 * 显存预设档位来自 节点包定义（banzhang_mmh3_upscale.py 的 _VRAM_PRESETS）：
 *   4 GB / 6 GB / 8 GB / 12 GB / 16 GB / 24 GB
 * 这里按启动时检测到的实际显存**动态选最接近的档位**，而不是硬编码 6GB。
 */

/** 节点包放大节点支持的显存预设档位（与节点 _VRAM_PRESETS 一致） */
const VRAM_PRESET_TIERS = [4, 6, 8, 12, 16, 24] as const

/** 免模型的最近邻放大（不加载任何模型，几乎不吃显存） */
const NEAREST_MODEL = '⚡ 最近邻精确（免模型）'

/** 作者原配的真放大模型（12GB+ 显存用，画质更好） */
const AUTHOR_UPSCALE_MODEL = 'minimax_h3_latent_upscaler_3d_bf16.safetensors'

/**
 * 把显存（MB）映射到最合适的预设档位。
 * 规则：取**不超过实际显存的最大档位**（宁可保守，避免 OOM）；
 * 若显存小于最小档位，用最小档位。
 */
export function pickVramPreset(vramMB: number): string {
  if (!Number.isFinite(vramMB) || vramMB <= 0) return '6 GB'
  const gb = vramMB / 1024
  let best: number = VRAM_PRESET_TIERS[0]
  for (const t of VRAM_PRESET_TIERS) {
    if (gb >= t) best = t
  }
  return `${best} GB`
}

/** 显存是否足够加载真放大模型（12GB 及以上按作者原配，不再降级） */
function isHighVram(vramMB: number): boolean {
  return vramMB >= 12 * 1024
}

/**
 * 按显存选 H3 主模型的「省显存档位」（BanZhang_H3MemoryOptimizer）。
 *
 * 档位定义（banzhang_selflift.py 的 _MEM_PRESETS）：
 *   ① 关（最快，不省显存）          前馈分块 1 / 头分组 1
 *   ② 轻度（省一点，画面完全不变）   前馈分块 2 / 头分组 4
 *   ③ 强力（省得多，画面基本不变）   前馈分块 4 / 头分组 8
 */
function pickMemPreset(vramMB: number): string {
  const gb = vramMB / 1024
  if (gb >= 16) return '① 关（最快，不省显存）'
  if (gb >= 12) return '② 轻度（省一点，画面完全不变）'
  if (gb >= 8) return '② 轻度（省一点，画面完全不变）'
  return '③ 强力（省得多，画面基本不变）'
}

/** 按显存选 SelfLift 的 token 分块大小（越小越省显存，越慢） */
function pickTokenChunk(vramMB: number): number {
  const gb = vramMB / 1024
  if (gb >= 24) return 8192
  if (gb >= 16) return 4096
  if (gb >= 12) return 4096
  if (gb >= 8) return 2048
  return 1024
}

/** 按显存选 SelfLift 的权重缓存预算 */
function pickWeightCache(vramMB: number): number {
  const gb = vramMB / 1024
  if (gb >= 24) return 8
  if (gb >= 16) return 6
  if (gb >= 12) return 4
  if (gb >= 8) return 2
  return 1
}

/**
 * 第三方插件调度器 → ComfyUI 标准调度器 的兜底映射。
 *
 * 模板作者常装 RES4LYF / ComfyUI-Impact 等插件，这些插件会往采样器下拉里加额外选项。
 * 本机没装对应插件时，ComfyUI 的 calculate_sigmas 会因 KeyError 直接失败。
 * 这里按曲线特性映射到最接近的标准调度器，尽量保留作者的意图：
 *   bong_tangent 是 RES4LYF 的 tangent 类曲线，接近 beta 的钟形分布。
 */
const EXTERNAL_SCHEDULER_FALLBACK: Record<string, string> = {
  bong_tangent: 'beta',
  bong_tangent_v2: 'beta',
  kl_optimal_v2: 'kl_optimal',
  align_your_steps: 'simple',
  align_your_steps_v2: 'simple',
  gits: 'simple',
  'beta57': 'beta'
}

export function adaptTemplateForGpu(apiJson: unknown, gpu: GpuInfo): unknown {
  if (!apiJson || typeof apiJson !== 'object' || Array.isArray(apiJson)) return apiJson
  const api = apiJson as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
  if (!gpu.vramKnown) return apiJson // 显存未知，不动模板

  const preset = pickVramPreset(gpu.vramMB)
  const highVram = isHighVram(gpu.vramMB)

  let changed = false
  for (const node of Object.values(api)) {
    const inputs = node.inputs
    if (!inputs) continue
    if (/BanZhang_MMH3_UpscaleParams/i.test(String(node.class_type))) {
      // 放大模型：低显存（<12GB）用免模型的最近邻放大避免 OOM；
      // 高显存（>=12GB）恢复作者原配的真放大模型（画质更好）。
      // 注意：**始终保留作者配的放大倍数**（二采 1.50、三采 1.00）——
      // 最近邻放大几乎不吃显存，锁成 1 会让二采/三采变成无意义重采样。
      const curModel = typeof inputs['放大模型'] === 'string' ? inputs['放大模型'] : ''
      if (highVram) {
        // 恢复真模型（模板里作者原配）
        if (curModel === NEAREST_MODEL && AUTHOR_UPSCALE_MODEL) {
          inputs['放大模型'] = AUTHOR_UPSCALE_MODEL
          changed = true
        }
      } else if (curModel && curModel !== NEAREST_MODEL) {
        inputs['放大模型'] = NEAREST_MODEL
        changed = true
      }
      // 显存预设按实际显存动态分档（4/6/8/12/16/24 GB）
      if (inputs['显存预设'] !== preset) {
        inputs['显存预设'] = preset
        changed = true
      }
    }
    if (/BanZhang_SLABlockSparseAttention/i.test(String(node.class_type))) {
      // 稀疏注意力计算块：低显存减半（64→32），高显存恢复 64
      if (!highVram) {
        if (inputs['计算块大小'] === '64') {
          inputs['计算块大小'] = '32'
          changed = true
        }
      } else if (inputs['计算块大小'] === '32') {
        inputs['计算块大小'] = '64'
        changed = true
      }
    }
    if (/BanZhang_VRAM_Guard/i.test(String(node.class_type))) {
      // 显存越小，预留越多（防止峰值 OOM）
      const reserve = gpu.vramMB >= 16 * 1024 ? 0.5 : gpu.vramMB >= 12 * 1024 ? 0.5 : gpu.vramMB >= 8 * 1024 ? 0.8 : 1.0
      if (typeof inputs['预留容量_GB'] === 'number' && inputs['预留容量_GB'] < reserve) {
        inputs['预留容量_GB'] = reserve
        changed = true
      }
    }
    // H3 主模型省显存档位：低显存开启前馈分块/注意力头分组
    if (/BanZhang_H3MemoryOptimizer/i.test(String(node.class_type))) {
      const preset = pickMemPreset(gpu.vramMB)
      if (typeof inputs['省显存档位'] === 'string' && inputs['省显存档位'] !== preset) {
        inputs['省显存档位'] = preset
        changed = true
      }
    }
    // SelfLift：token 分块 / 权重缓存预算按显存调整
    if (/BanZhang_SelfLiftMultiStage/i.test(String(node.class_type))) {
      const chunk = pickTokenChunk(gpu.vramMB)
      if (typeof inputs['token分块大小'] === 'number' && inputs['token分块大小'] !== chunk) {
        inputs['token分块大小'] = chunk
        changed = true
      }
      const cache = pickWeightCache(gpu.vramMB)
      if (typeof inputs['权重缓存预算'] === 'number' && inputs['权重缓存预算'] !== cache) {
        inputs['权重缓存预算'] = cache
        changed = true
      }
    }
    // 调度器兜底：模板作者可能用了第三方插件提供的调度器（如 RES4LYF 的 bong_tangent），
    // 本机没装那个插件时 ComfyUI 会直接抛 KeyError。这里映射到语义最接近的标准调度器，
    // 不静默改成 simple（simple 与 bong_tangent 曲线差别较大）。
    // 注：ComfyUI 标准调度器只有 simple/sgm_uniform/karras/exponential/ddim_uniform/beta/normal/linear_quadratic/kl_optimal。
    if (typeof inputs['调度器'] === 'string') {
      const sch = inputs['调度器']
      const fallback = EXTERNAL_SCHEDULER_FALLBACK[sch]
      if (fallback) {
        inputs['调度器'] = fallback
        changed = true
      }
    }
  }
  return changed ? api : apiJson
}

// ---------- 缺失模型降级 ----------

/** 递归收集 models 目录下所有文件名（限制深度，缓存） */
function scanModelNames(root: string, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 4) return out
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(root, e.name)
    if (e.isFile()) out.add(e.name)
    else if (e.isDirectory()) scanModelNames(p, depth + 1, out)
  }
  return out
}

const scanCache = new Map<string, { at: number; names: Set<string> }>()
function modelNamesOf(modelsRoot: string): Set<string> {
  const c = scanCache.get(modelsRoot)
  if (c && Date.now() - c.at < 10000) return c.names
  const names = scanModelNames(modelsRoot)
  scanCache.set(modelsRoot, { at: Date.now(), names })
  return names
}

/**
 * 缺失模型自动降级：工作流引用的 LoRA 若本机没有对应文件，把其强度置 0（等于不启用），
 * 避免 ComfyUI 因 "Value not in list" 直接报错。
 *
 * 针对私有/社区 LoRA（QuadView_krea2_v1、krea2-Cc-天魔-身材、krea2-美学人像摄影 等无公开源）：
 * 用户下载了公开替代模型后，这几个 LoRA 仍然缺失，此函数保证工作流照常运行。
 */
export function degradeMissingLoras(apiJson: unknown, modelsRoot: string | null): unknown {
  if (!apiJson || typeof apiJson !== 'object' || Array.isArray(apiJson)) return apiJson
  if (!modelsRoot) return apiJson
  const names = modelNamesOf(modelsRoot)
  const api = apiJson as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
  let changed = false
  for (const node of Object.values(api)) {
    const inputs = node.inputs
    if (!inputs) continue
    const ct = String(node.class_type)
    if (/LoraLoaderModelOnly|LoraLoader/i.test(ct)) {
      const lora = inputs['lora_name']
      if (typeof lora === 'string' && lora && !names.has(path.basename(lora))) {
        // 缺文件 → 强度置 0（不启用该 LoRA）
        if (inputs['strength_model'] !== 0) {
          inputs['strength_model'] = 0
          changed = true
        }
      }
    }
    if (/BanZhang_LoRA_VramSafe/i.test(ct)) {
      const lora = inputs['LoRA文件']
      if (typeof lora === 'string' && lora && !names.has(path.basename(lora))) {
        inputs['LoRA文件'] = ''
        changed = true
      }
    }
  }
  return changed ? api : apiJson
}
