import type { Asset, AssetKind, Template } from '@shared/types'

/** 资产生图：画风库 + 四视图提示词（单条生成与一键批量共用） */

export interface StyleDef {
  id: string
  label: string
  /** 正向风格词 */
  positive: string
  /** 反向风格词（压制不该出现的画风） */
  negative: string
}

/** 可选画风（默认第一个 = 游戏 CG 写实真人） */
export const STYLES: StyleDef[] = [
  {
    id: 'cg_real',
    label: '游戏CG写实（推荐·接近真人）',
    positive:
      'AAA game CG character, semi-realistic photorealistic human, lifelike realistic skin texture with pores, detailed skin shading, anatomically realistic proportions, volumetric cinematic lighting, physically based rendering (PBR), Unreal Engine 5 quality, 8k ultra detailed, sharp focus',
    negative: 'anime, cartoon, cel shading, 2d illustration, doll-like, plastic skin, flat shading'
  },
  {
    id: 'real_photo',
    label: '真人电影剧照（照片级）',
    positive:
      'cinematic film still, photorealistic real human, natural realistic skin with pores and fine detail, true-to-life anatomy, professional cinema lighting, shot on 35mm, ultra detailed, sharp focus',
    negative: 'anime, cartoon, 3d render, cgi, illustration, painting, doll-like, plastic skin'
  },
  {
    id: 'cg_3d',
    label: '3D 动画/影视建模',
    positive:
      'high quality 3D CG character render, stylized 3d animation film character, smooth detailed skin, subsurface scattering, cinematic lighting, Pixar/Disney style 3d, 8k',
    negative: 'real photo, flat 2d, sketch, low quality'
  },
  {
    id: 'anime',
    label: '动漫/二次元',
    positive:
      'high quality anime character illustration, clean lineart, vivid cel shading, detailed anime eyes, japanese anime style, crisp, sharp focus',
    negative: 'realistic photo, 3d render, sketch, blurry, low quality'
  },
  {
    id: 'ink_chinese',
    label: '国风水墨',
    positive:
      'traditional chinese ink painting style, guofeng, elegant brush strokes, ink wash, oriental aesthetics, negative space, artistic',
    negative: 'photorealistic, 3d render, anime, western, low quality'
  },
  {
    id: 'comic_marvel',
    label: '美漫/漫画',
    positive:
      'american comic book style, bold ink outlines, dramatic lighting, vibrant colors, halftone shading, dynamic, comic illustration',
    negative: 'photorealistic, anime, 3d render, low quality'
  }
]

export const DEFAULT_STYLE_ID = 'cg_real'

export function getStyle(id: string | undefined): StyleDef {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]
}

/** 四视图构图（不含画风，画风单独拼在最前） */
const FOUR_VIEW_BODY =
  'character design reference sheet, the same single character shown in four views arranged in one horizontal row, gender and outfit consistent across all views; ' +
  'leftmost: upper-body close-up portrait of the front view, face clearly visible with detailed facial features, sharp focus on the face; ' +
  'then three full-body standing views: front view full body, side view full body, back view full body; ' +
  'same hairstyle, outfit and colors in every view; neutral standing pose; plain light gray studio background; '
const FOUR_VIEW_TAIL = ' ; clean character turnaround sheet, high detail, sharp focus, consistent design across views'

const FOUR_VIEW_STRUCT_NEG =
  'multiple different characters, inconsistent design, different outfit between views, different face, extra heads, extra limbs, deformed, bad anatomy, blurry face, text, watermark, logo, signature, cropped, out of frame, low quality'

/** 角色四视图正向提示词（含画风） */
export function buildFourViewPositive(desc: string, styleId?: string): string {
  const style = getStyle(styleId)
  const d = desc.trim().replace(/[;,\s]+$/, '')
  const body = d ? `${FOUR_VIEW_BODY}${d}` : `${FOUR_VIEW_BODY}a character`
  return `${style.positive}; ${body}${FOUR_VIEW_TAIL}`
}

/** 角色四视图负向提示词（画风负词 + 结构负词） */
export function fourViewNegative(styleId?: string): string {
  const style = getStyle(styleId)
  return `${style.negative}, ${FOUR_VIEW_STRUCT_NEG}`
}

/** 单图画风前缀（场景/道具等） */
export function styledPositive(desc: string, styleId?: string): string {
  const style = getStyle(styleId)
  const d = desc.trim()
  return d ? `${style.positive}; ${d}` : style.positive
}

/** 按资产类型挑图片模板：角色优先 Z-Image-Turbo，其余用第一个图片模板 */
export function pickAssetTemplate(templates: Template[], kind: AssetKind): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  if (imgs.length === 0) return undefined
  if (kind === 'character') {
    return imgs.find((t) => /Z-?Image-?Turbo/i.test(t.name)) || imgs.find((t) => /Z-?Image/i.test(t.name)) || imgs[0]
  }
  return imgs[0]
}

export interface AssetJobInput {
  templateId: string
  positive: string
  negative?: string
  width: number
  height: number
  batch: number
}

const FOUR_VIEW_W = 1536
const FOUR_VIEW_H = 640

/** 根据资产生成 jobGenerate 参数：角色→四视图（横图），其他→单图，均按所选画风 */
export function buildAssetJobInput(asset: Asset, templates: Template[], styleId?: string): AssetJobInput | null {
  const template = pickAssetTemplate(templates, asset.kind)
  if (!template) return null
  const style = getStyle(styleId)
  const desc = asset.prompt || asset.description || asset.name || ''
  const isChar = asset.kind === 'character'
  if (isChar) {
    return {
      templateId: template.id,
      positive: buildFourViewPositive(desc, styleId),
      negative: fourViewNegative(styleId),
      width: FOUR_VIEW_W,
      height: FOUR_VIEW_H,
      batch: 1
    }
  }
  return {
    templateId: template.id,
    positive: styledPositive(desc, styleId),
    negative: [style.negative, asset.negative].filter(Boolean).join(', ') || undefined,
    width: 1024,
    height: 1024,
    batch: 1
  }
}
