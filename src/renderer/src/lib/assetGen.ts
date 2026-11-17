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
      'AAA game CG character, semi-realistic photorealistic adult human, lifelike realistic skin texture with pores, detailed skin shading, anatomically correct adult proportions, realistic 7-to-8 heads tall body ratio, natural human anatomy, volumetric cinematic lighting, physically based rendering (PBR), Unreal Engine 5 quality, 8k ultra detailed, sharp focus',
    negative: 'anime, cartoon, cel shading, 2d illustration, doll-like, plastic skin, flat shading, chibi, chibi style, kawaii, super deformed, SD character, big head, oversized head, small body, short legs, stubby limbs, childlike proportions, baby face, toy, figurine, bobblehead'
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
  'character design reference sheet, the same single adult character shown in four views arranged in one horizontal row, gender and outfit consistent across all views; ' +
  'leftmost: upper-body close-up portrait of the front view, face clearly visible with detailed realistic facial features, sharp focus on the face; ' +
  'then three full-body standing views: front view full body, side view full body, back view full body; ' +
  'all full-body views show the complete figure from head to feet with realistic adult proportions (7 to 8 heads tall, normal head size, long natural legs); ' +
  'same hairstyle, outfit and colors in every view; neutral standing pose; ' +
  'flat even studio lighting, soft uniform ambient light, no directional light, ' +
  'no cast shadow, no drop shadow, no ground shadow, no floor, no floor line, no scenery, ' +
  'figures floating flat on a plain pure light gray background; '
const FOUR_VIEW_TAIL = ' ; clean character turnaround sheet, even lighting, shadowless, high detail, sharp focus, consistent design across views'

const FOUR_VIEW_STRUCT_NEG =
  'multiple different characters, inconsistent design, different outfit between views, different face, extra heads, extra limbs, deformed, bad anatomy, blurry face, text, watermark, logo, signature, cropped, out of frame, low quality, chibi, super deformed, big head, oversized head, tiny body, short legs, childlike, doll, figurine, ' +
  'cast shadow, drop shadow, ground shadow, floor shadow, shadow on wall, shadow on background, floor, ground, floor line, horizon line, scenery, gradient background, spotlight, dramatic lighting, harsh light, vignette'

/** 角色四视图正向提示词（只要构图，不注入画风前缀） */
export function buildFourViewPositive(desc: string, _styleId?: string): string {
  const d = desc.trim().replace(/[;,\s]+$/, '')
  const body = d ? `${FOUR_VIEW_BODY}${d}` : `${FOUR_VIEW_BODY}a character`
  return body + FOUR_VIEW_TAIL
}

/** 四视图负向提示词：结构词 + 投影压制（styleId 省略时不加画风负词） */
export function fourViewNegative(styleId?: string): string {
  if (!styleId) return FOUR_VIEW_STRUCT_NEG
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
  /** 参考图（图片编辑/图生图/转四视图用） */
  refImages?: string[]
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

// ---------- 角色资产生成三步流程（千问同模型：文生图 → 转四视图 / 图片编辑） ----------

/** 过滤出可用于展示的版本图（去空、去重，保持生成顺序） */
export function filterRenderableVersions(images: string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of images ?? []) {
    if (typeof f !== 'string' || !f.trim()) continue
    if (seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  return out
}

/** 千问文生图模板 */
export function pickQwenT2ITemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return (
    imgs.find((t) => /Qwen-image21-文生图|qwen_image_2_1_t2i/i.test(t.name)) ||
    imgs.find((t) => /Qwen/i.test(t.name) && /文生图|t2i/i.test(t.name))
  )
}

/** 千问图片编辑模板（CSGlideImageCastCS，支持参考图） */
export function pickQwenEditTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return (
    imgs.find((t) => /千问图片编辑|全能编辑/i.test(t.name)) ||
    imgs.find((t) => /Qwen/i.test(t.name) && /编辑|edit/i.test(t.name))
  )
}

/** 步骤1：文生图生成角色单图（不带参考图） */
export function buildCharacterT2IInput(asset: Asset, templates: Template[], _styleId?: string): AssetJobInput | null {
  const template = pickQwenT2ITemplate(templates)
  if (!template) return null
  // 提示词直接用原文，不加风格前缀（风格由提示词本身描述，避免风格词干扰主体描述）
  const desc = asset.prompt || asset.description || asset.name || ''
  return {
    templateId: template.id,
    positive: desc,
    negative: asset.negative || undefined,
    width: 1024,
    height: 1024,
    batch: 1
  }
}

/** 步骤2a：满意 → 用千问编辑+参考图 转四视图 */
export function buildCharacterFourViewInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string
): AssetJobInput | null {
  const template = pickQwenEditTemplate(templates)
  if (!template || !refImage) return null
  const desc = asset.prompt || asset.description || asset.name || ''
  return {
    templateId: template.id,
    positive: buildFourViewPositive(desc, styleId),
    // 结构词必须带上（含 no shadow / no floor 压制），再叠加资产自身负词
    negative: [fourViewNegative(), asset.negative].filter(Boolean).join(', '),
    width: FOUR_VIEW_W,
    height: FOUR_VIEW_H,
    batch: 1,
    refImages: [refImage]
  }
}

/** 步骤2b：不满意 → 用千问编辑+参考图 按指令修改（画布跟随参考图，width/height=0） */
export function buildCharacterEditInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string,
  editPrompt: string
): AssetJobInput | null {
  const template = pickQwenEditTemplate(templates)
  if (!template || !refImage) return null
  const prompt = (editPrompt || '').trim()
  if (!prompt) return null
  return {
    templateId: template.id,
    positive: prompt,
    negative: asset.negative || undefined,
    width: 0,
    height: 0,
    batch: 1,
    refImages: [refImage]
  }
}
