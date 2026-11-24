import type { Shot, SegmentSettings, UpscaleSettings, RifeSettings } from '@shared/types'

/** 分段导演台：段参数默认值 / 工具 */

export const RATIO_OPTIONS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const

/**
 * 由宽高推出最接近的标准比例标签。
 * ratio 只用于 UI 分组（后端并不读它），所以对小尺寸的低配档也归一到标准比例：
 * 576×320(1.80)、896×480(1.87) 都归 16:9；绝不再返回 "576:320" 这种数字串。
 * 横屏/竖屏分别只在横屏/竖屏比例里找，避免 16:9 被误判成 21:9。
 */
export function ratioOf(w: number, h: number): string {
  const r = w / h
  const landscape = r >= 1
  const known: [string, number][] = [
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['1:1', 1],
    ['21:9', 21 / 9],
    ['9:16', 9 / 16],
    ['3:4', 3 / 4]
  ]
  const candidates = known.filter(([, v]) => (v >= 1) === landscape)
  let best = landscape ? '16:9' : '9:16'
  let bestDiff = Infinity
  for (const [label, v] of candidates) {
    const diff = Math.abs(r - v)
    if (diff < bestDiff) {
      bestDiff = diff
      best = label
    }
  }
  return best
}

/**
 * 帧数吸附到 17k+5（H3 只接受这个网格）。
 * 与主进程 src/main/core/h3-prompt.ts 的 alignFrames 同一口径；
 * renderer 不能 import main，故此处保留一份同实现的纯函数。
 */
export function alignFrames(n: number): number {
  let v = Math.max(5, Math.round(n))
  while (v % 17 !== 5) v += 1
  return v
}

/**
 * 秒 → 帧。H3 只接受 **17k+5** 的帧数（5, 22, 39, … 124, 141, …），
 * 落不到网格上的值会被节点拒绝或静默按别的长度跑。
 * 这里与导演台的 alignFrames() 同一口径：向上吸附到最近的合法格。
 */
export function framesFor(durationSec: number, fps: number): number {
  const raw = Math.max(1, Math.round(durationSec * fps) + 1)
  return alignFrames(raw)
}

export const defaultUpscale: UpscaleSettings = {
  enabled: false,
  mode: '倍数',
  scale: 1,
  targetWidth: 1280,
  targetHeight: 704,
  steps: 2,
  denoise: 0.45,
  audioDenoise: 0.3,
  sampler: 'euler',
  scheduler: 'simple',
  tileFrames: 107,
  overlapFrames: 22
}

export const defaultRife: RifeSettings = {
  enabled: false,
  fps: 24,
  multiplier: 2,
  keepAudio: true
}

/** 按分镜生成默认段参数；第一段默认不续接，后续段默认 latent 续接 */
export function defaultSegment(
  shot: Shot,
  preset: { width: number; height: number; frames: number } | null,
  index: number
): SegmentSettings {
  const width = preset?.width ?? 576
  const height = preset?.height ?? 320
  const fps = 24
  const durationSec = shot.duration && shot.duration > 0 ? shot.duration : Math.max(1, Math.round(((preset?.frames ?? 33) - 1) / fps))
  return {
    width,
    height,
    ratio: ratioOf(width, height),
    durationSec,
    fps,
    frames: framesFor(durationSec, fps),
    pinHead: 0,
    pinTail: 0,
    refImageSize: 'match',
    refVideoSize: 768,
    refVideoFps: 24,
    refScaleHd: 1,
    bridgeAdapter: '',
    bridgeAlpha: 0,
    bridgeMode: 'full',
    aliasMode: true,
    pace: 2.5,
    contMode: index === 0 ? 'none' : 'latent',
    // 承接帧数：取上一段尾部 22 帧钉在本段开头（合法值 5/22/39/56/73…）
    contFrames: 22,
    stages: { first: true, second: true, third: true, superRes: false },
    pushWhole: false,
    genMode: 'ref2va',
    upscale: { ...defaultUpscale },
    rife: { ...defaultRife }
  }
}

export function getSegment(
  shot: Shot,
  preset: { width: number; height: number; frames: number } | null,
  index: number
): SegmentSettings {
  const s = shot.segment ?? defaultSegment(shot, preset, index)
  // 老工程可能存着非 17k+5 的帧数（旧版 framesFor 没吸附），读出来统一校正，
  // 否则 H3 会拒绝或按别的长度跑 —— 与导演台 parseInitial 的 alignFrames 同口径。
  const aligned = alignFrames(s.frames)
  if (aligned === s.frames) return s
  const fps = s.fps || 24
  return { ...s, frames: aligned, durationSec: Math.round(((aligned - 1) / fps) * 100) / 100 }
}
