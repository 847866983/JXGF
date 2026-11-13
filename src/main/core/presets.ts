import type { GenerationPreset, GpuInfo, HardwareReport } from '@shared/types'

/**
 * 显存档位预设：按「目标机器显存」自动决定分辨率 / 帧数 / 采样策略。
 * 这是面向大众分发的关键 —— 不同配置拿到的生成参数不同，
 * 保证 6GB 也能跑、24GB 能跑满，而不是一刀切然后低配机 OOM。
 */
export const PRESETS: GenerationPreset[] = [
  {
    id: 'flagship',
    label: '旗舰档',
    minVramMB: 24 * 1024,
    maxVramMB: null,
    video: { width: 1920, height: 1080, frames: 97, fps: 24, passes: 3, lowvram: false, quantized: false },
    image: { width: 1920, height: 1080 },
    note: '24GB 及以上显存，全分辨率全帧数'
  },
  {
    id: 'pro',
    label: '进阶档',
    minVramMB: 16 * 1024,
    maxVramMB: 24 * 1024 - 1,
    video: { width: 1280, height: 720, frames: 81, fps: 24, passes: 2, lowvram: false, quantized: false },
    image: { width: 1536, height: 864 },
    note: '16GB 显存，720p 高帧数'
  },
  {
    id: 'standard',
    label: '标准档',
    minVramMB: 12 * 1024,
    maxVramMB: 16 * 1024 - 1,
    video: { width: 1280, height: 720, frames: 65, fps: 24, passes: 2, lowvram: false, quantized: true },
    image: { width: 1280, height: 720 },
    note: '12GB 显存，720p 标准帧数'
  },
  {
    id: 'entry',
    label: '入门档',
    minVramMB: 8 * 1024,
    maxVramMB: 12 * 1024 - 1,
    video: { width: 1024, height: 576, frames: 49, fps: 24, passes: 1, lowvram: false, quantized: true },
    image: { width: 1024, height: 576 },
    note: '8GB 显存，576p'
  },
  {
    id: 'minimal',
    label: '低配档',
    minVramMB: 6 * 1024,
    maxVramMB: 8 * 1024 - 1,
    video: { width: 896, height: 480, frames: 33, fps: 24, passes: 1, lowvram: true, quantized: true },
    image: { width: 896, height: 480 },
    note: '6GB 显存，480p 短帧，开启低显存模式'
  },
  {
    id: 'limited',
    label: '受限档',
    minVramMB: 0,
    maxVramMB: 6 * 1024 - 1,
    video: { width: 640, height: 360, frames: 16, fps: 24, passes: 1, lowvram: true, quantized: true },
    image: { width: 768, height: 432 },
    note: '显存不足或非 NVIDIA，仅建议出图或走远程模式'
  }
]

export function presetFor(vramMB: number): GenerationPreset {
  return PRESETS.find((p) => vramMB >= p.minVramMB && (p.maxVramMB === null || vramMB <= p.maxVramMB)) ?? PRESETS[PRESETS.length - 1]
}

export function buildHardwareReport(gpu: GpuInfo): HardwareReport {
  const preset = presetFor(gpu.vramKnown ? gpu.vramMB : 0)
  const recommendations: string[] = []
  let comfyMode: HardwareReport['comfyMode']

  if (gpu.vendor === 'nvidia' && gpu.cudaAvailable && gpu.vramMB >= 6 * 1024) {
    comfyMode = 'local-full'
    recommendations.push(`检测到 ${gpu.name}（${(gpu.vramMB / 1024).toFixed(0)}GB），使用「${preset.label}」。`)
  } else if (gpu.vendor === 'nvidia' && gpu.vramMB > 0) {
    comfyMode = 'local-image'
    recommendations.push('显存低于 6GB：本地只建议生成图片，视频请使用远程 ComfyUI。')
  } else if (gpu.vendor === 'amd' || gpu.vendor === 'intel') {
    comfyMode = 'local-image'
    recommendations.push(`${gpu.name} 在 Windows 上对视频工作流支持有限，建议降级为图片生成或使用远程 ComfyUI。`)
  } else {
    comfyMode = 'remote'
    recommendations.push('未检测到可用显卡，请配置远程 ComfyUI 地址。')
  }
  recommendations.push(`目标档位：${preset.video.width}×${preset.video.height} @ ${preset.video.frames} 帧。`)

  return { gpu, preset, comfyMode, recommendations, detectedAt: new Date().toISOString() }
}
