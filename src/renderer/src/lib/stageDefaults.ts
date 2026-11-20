/**
 * 从工作流 UI JSON 里读出每个「阶段分组」的默认采样参数。
 *
 * 分组名（ComfyUI 的 groups）就是 一采 / 二采 / 三采 / 超分，
 * 组内如果放了 KSampler，就取它的 widgets：
 *   [seed, 生成后控制, 步数, CFG, 采样器, 调度器, 降噪]
 * 读不到就给空对象，界面上显示占位符「默认」。
 */

export interface StageSampler {
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  denoise?: number
}

export type StageKey = 'first' | 'second' | 'third' | 'superRes'

function stageOf(title: string): StageKey | null {
  if (/超分/.test(title)) return 'superRes'
  if (/三采/.test(title)) return 'third'
  if (/二采/.test(title)) return 'second'
  if (/一采/.test(title)) return 'first'
  return null
}

export function readStageDefaults(ui: unknown): Partial<Record<StageKey, StageSampler>> {
  const doc = ui as {
    groups?: { title?: string; bounding?: number[] }[]
    nodes?: { type?: string; pos?: number[]; widgets_values?: unknown[] }[]
  } | null
  const out: Partial<Record<StageKey, StageSampler>> = {}
  if (!doc || !Array.isArray(doc.groups) || !Array.isArray(doc.nodes)) return out

  for (const g of doc.groups) {
    const key = stageOf(String(g.title ?? ''))
    if (!key || !Array.isArray(g.bounding)) continue
    const [gx, gy, gw, gh] = g.bounding
    const inGroup = (n: { pos?: number[] }): boolean => {
      const p = n.pos
      return Array.isArray(p) && p[0] >= gx && p[0] <= gx + gw && p[1] >= gy && p[1] <= gy + gh
    }
    // 二采/三采的采样节点是 BanZhang_MMH3_Upscale（不是标准 KSampler）
    const up = doc.nodes.find((n) => String(n.type ?? '') === 'BanZhang_MMH3_Upscale' && inGroup(n as { pos?: number[] }))
    if (up && Array.isArray(up.widgets_values)) {
      const w = up.widgets_values
      // [lora_file, lora_strength, 随机种子, 采样器, 调度器, 步数, 去噪强度, 音频重绘强度]
      // [lora_file, lora_strength, 随机种子, 生成后控制, 采样器, 调度器, 步数, 去噪强度, ...]
      out[key] = {
        sampler: typeof w[4] === 'string' ? (w[4] as string) : undefined,
        scheduler: typeof w[5] === 'string' ? (w[5] as string) : undefined,
        steps: Number(w[6]) || undefined,
        denoise: typeof w[7] === 'number' ? (w[7] as number) : undefined
      }
      continue
    }
    const ks = doc.nodes.find((n) => {
      if (!/^KSampler|KSamplerAdvanced$/.test(String(n.type ?? ''))) return false
      return inGroup(n as { pos?: number[] })
    })
    if (!ks || !Array.isArray(ks.widgets_values)) continue
    const w = ks.widgets_values
    const isAdvanced = String(ks.type) === 'KSamplerAdvanced'
    const off = isAdvanced ? 2 : 2 // 两者步数都在第 3 位（前两位是种子+控制）
    const cfg = Number(w[off + 1])
    const denoiseIdx = isAdvanced ? 0 : 6
    out[key] = {
      steps: Number(w[off]) || undefined,
      cfg: Number.isFinite(cfg) ? cfg : undefined,
      sampler: typeof w[off + 2] === 'string' ? (w[off + 2] as string) : undefined,
      scheduler: typeof w[off + 3] === 'string' ? (w[off + 3] as string) : undefined,
      denoise:
        typeof w[denoiseIdx] === 'number'
          ? (w[denoiseIdx] as number)
          : typeof w[6] === 'number'
            ? (w[6] as number)
            : undefined
    }
  }
  return out
}
