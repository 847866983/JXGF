import type { Shot, SegmentSettings, UpscaleSettings, RifeSettings } from '@shared/types'

/** 分段导演台：段参数默认值 / 工具 */

export function ratioOf(w: number, h: number): string {
  const r = w / h
  const known: [string, number][] = [
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['1:1', 1],
    ['21:9', 21 / 9]
  ]
  for (const [label, v] of known) if (Math.abs(r - v) < 0.02) return label
  return `${w}:${h}`
}

export function framesFor(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps) + 1)
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
    pace: 2.5,
    contMode: index === 0 ? 'none' : 'latent',
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
  return shot.segment ?? defaultSegment(shot, preset, index)
}
