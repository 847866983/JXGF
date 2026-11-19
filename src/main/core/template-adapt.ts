import fs from 'node:fs'
import path from 'node:path'
import type { GpuInfo } from '@shared/types'

/**
 * 按本机显存自动适配导入的工作流模板（目前针对 H3 三采的 BanZhang 放大节点）。
 *
 * 背景：H3 模板默认按 12GB 显存配置，放大节点加载真实放大模型
 *   minimax_h3_latent_upscaler_3d_bf16.safetensors（约 2-3GB 显存），
 *   在 6GB 显卡上必然 OOM（实测 BanZhang_MMH3_Upscale Allocation on device）。
 * 处理：显存 < 10GB 时，把放大节点改成「最近邻精确（免模型）」+ 倍数 1 + 显存预设 6GB，
 *   避免加载大模型，视频质量略降但能稳定出片。
 */
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
  if (!gpu.vramKnown || gpu.vramMB >= 10 * 1024) return apiJson // 显存够，不动

  let changed = false
  for (const node of Object.values(api)) {
    const inputs = node.inputs
    if (!inputs) continue
    if (/BanZhang_MMH3_UpscaleParams/i.test(String(node.class_type))) {
      // 只把「要加载大模型的放大」换成免模型的最近邻放大。
      // 注意：**保留作者配的放大倍数**（截图里二采是 1.50）——
      // 最近邻放大本身几乎不吃显存，把倍数锁成 1 会让二采/三采变成无意义重采样，
      // 画质白白损失，也偏离作者原意。
      if (typeof inputs['放大模型'] === 'string' && inputs['放大模型'] !== '⚡ 最近邻精确（免模型）') {
        inputs['放大模型'] = '⚡ 最近邻精确（免模型）'
        changed = true
      }
      if (inputs['显存预设'] !== '6 GB') {
        inputs['显存预设'] = '6 GB'
        changed = true
      }
    }
    if (/BanZhang_SLABlockSparseAttention/i.test(String(node.class_type))) {
      if (inputs['计算块大小'] === '64') {
        inputs['计算块大小'] = '32'
        changed = true
      }
    }
    if (/BanZhang_VRAM_Guard/i.test(String(node.class_type))) {
      if (typeof inputs['预留容量_GB'] === 'number' && inputs['预留容量_GB'] < 0.5) {
        inputs['预留容量_GB'] = 0.5
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
