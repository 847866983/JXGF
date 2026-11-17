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
export function adaptTemplateForGpu(apiJson: unknown, gpu: GpuInfo): unknown {
  if (!apiJson || typeof apiJson !== 'object' || Array.isArray(apiJson)) return apiJson
  const api = apiJson as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
  if (!gpu.vramKnown || gpu.vramMB >= 10 * 1024) return apiJson // 显存够，不动

  let changed = false
  for (const node of Object.values(api)) {
    const inputs = node.inputs
    if (!inputs) continue
    // BanZhang_MMH3_UpscaleParams：换成免模型、倍数1、6GB预设
    if (/BanZhang_MMH3_UpscaleParams/i.test(String(node.class_type))) {
      if (typeof inputs['放大模型'] === 'string' && inputs['放大模型'] !== '⚡ 最近邻精确（免模型）') {
        inputs['放大模型'] = '⚡ 最近邻精确（免模型）'
        changed = true
      }
      if (inputs['放大倍数'] !== 1) {
        inputs['放大倍数'] = 1
        changed = true
      }
      if (inputs['显存预设'] !== '6 GB') {
        inputs['显存预设'] = '6 GB'
        changed = true
      }
    }
    // BanZhang_SLABlockSparseAttention：计算块降级省显存
    if (/BanZhang_SLABlockSparseAttention/i.test(String(node.class_type))) {
      if (inputs['计算块大小'] === '64') {
        inputs['计算块大小'] = '32'
        changed = true
      }
    }
    // BanZhang_VRAM_Guard：多预留一点
    if (/BanZhang_VRAM_Guard/i.test(String(node.class_type))) {
      if (typeof inputs['预留容量_GB'] === 'number' && inputs['预留容量_GB'] < 0.5) {
        inputs['预留容量_GB'] = 0.5
        changed = true
      }
    }
    // 已知非法调度器
    if (inputs['调度器'] === 'bong_tangent') {
      inputs['调度器'] = 'simple'
      changed = true
    }
  }
  return changed ? api : apiJson
}
