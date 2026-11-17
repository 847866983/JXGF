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

/** 四视图结构负向词（配合固定提示词，抑制投影/地面/走形） */
const FOUR_VIEW_STRUCT_NEG =
  'multiple different characters, inconsistent design, different outfit between views, different face, extra heads, extra limbs, deformed, bad anatomy, blurry face, text, watermark, logo, signature, cropped, out of frame, low quality, chibi, super deformed, big head, oversized head, tiny body, short legs, childlike, doll, figurine, ' +
  'cast shadow, drop shadow, ground shadow, floor shadow, shadow on wall, shadow on background, floor, ground, floor line, horizon line, scenery, gradient background, spotlight, dramatic lighting, harsh light, vignette, ' +
  'fading edges, faded edges, ghosting, ghost image, translucent figure, semi-transparent figure, transparent figure, blurry edges, soft edges, white fade, white glow, overexposed, washed out'

/**
 * 四视图固定提示词（用户指定，原样发送，不拼接风格/描述）。
 * 用千问编辑模板 + 角色参考图，让模型把参考图转成四视图角色设定表。
 */
export const FOUR_VIEW_PROMPT =
  'Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views. Every full-body view shows the complete figure from head to feet, nothing cropped, whole body visible with feet on the ground. Arrange the views side by side on a plain pure white background, each figure fully opaque with sharp clean edges, crisp outlines, no fading, no ghosting.'

/** 兼容旧调用：四视图正向提示词固定为 FOUR_VIEW_PROMPT */
export function buildFourViewPositive(_desc?: string, _styleId?: string): string {
  return FOUR_VIEW_PROMPT
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
  /** 需要挂载的 LoRA（如千问多角度四视图） */
  loras?: { file: string; strength: number }[]
  /** 采样步数（覆盖模板默认，提升清晰度） */
  steps?: number
}

// 四视图画布用方形：超宽(1536x640)时模型要在两侧"补白"排视图，
// 实测出现边缘渐隐/泛白/重影；1024x1024 方形画布下四视图干净清晰。
const FOUR_VIEW_W = 1024
const FOUR_VIEW_H = 1024

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

// ---------- 角色资产生成（双引擎：千问 / Krea2） ----------

/** 生图引擎 */
export type ImageEngine = 'qwen' | 'krea2'

/** 引擎显示名 */
export const ENGINE_LABEL: Record<ImageEngine, string> = {
  qwen: '千问 Qwen-Image 2.1',
  krea2: 'Krea2'
}

/** 千问四视图多角度 LoRA（已下载到 models/loras） */
export const QWEN_QUADVIEW_LORA = 'qwen21_multiple_angles_v2.safetensors'

/** 千问四视图提示词：<mva> 触发 + 四视图描述（配合多角度 LoRA） */
export const QWEN_QUADVIEW_PROMPT =
  '<mva> Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views. Arrange the four views side by side in one horizontal row on a plain pure white background, each figure fully opaque with sharp clean edges, crisp outlines, no fading, no ghosting.'

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

/** Krea2 角色四视图模板（图生图重生成，非编辑原图） */
export function pickFourViewTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return (
    imgs.find((t) => /四视图/i.test(t.name) && /Krea2/i.test(t.name)) ||
    imgs.find((t) => /Krea2/i.test(t.name) && /四视图|QuadView/i.test(t.name)) ||
    imgs.find((t) => /四视图/i.test(t.name))
  )
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

/** Krea2 文生图模板 */
export function pickKrea2T2ITemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return (
    imgs.find((t) => /Krea2/i.test(t.name) && /单双采|文生图|t2i/i.test(t.name)) ||
    imgs.find((t) => /Krea2/i.test(t.name) && !/四视图/i.test(t.name))
  )
}

/** 按引擎选文生图模板 */
export function pickT2ITemplate(templates: Template[], engine: ImageEngine): Template | undefined {
  return engine === 'krea2' ? pickKrea2T2ITemplate(templates) : pickQwenT2ITemplate(templates)
}

/** 步骤1：文生图生成角色单图（不带参考图），支持双引擎 */
export function buildCharacterT2IInput(
  asset: Asset,
  templates: Template[],
  _styleId?: string,
  engine: ImageEngine = 'qwen'
): AssetJobInput | null {
  const template = pickT2ITemplate(templates, engine)
  if (!template) return null
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

/** 步骤2a：满意 → 转四视图。Krea2 用现成四视图模板；千问用编辑+多角度LoRA */
export function buildCharacterFourViewInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string,
  engine: ImageEngine = 'krea2'
): AssetJobInput | null {
  if (engine === 'krea2') {
    const template = pickFourViewTemplate(templates)
    if (!template || !refImage) return null
    return {
      templateId: template.id,
      positive: FOUR_VIEW_PROMPT,
      negative: undefined, // Krea2 turbo 不用负向词
      width: 0, // 画幅交给模板（2000x1200）
      height: 0,
      batch: 1,
      refImages: [refImage]
    }
  }
  // 千问：编辑模板 + 多角度 LoRA，提示词用 <mva> 语法
  const template = pickQwenEditTemplate(templates)
  if (!template || !refImage) return null
  return {
    templateId: template.id,
    positive: QWEN_QUADVIEW_PROMPT,
    negative: fourViewNegative(),
    // 与 Krea2 对齐：2000x1200、8 步（清晰度足够，6GB 可跑）
    width: 2000,
    height: 1200,
    batch: 1,
    steps: 8,
    refImages: [refImage],
    loras: [{ file: QWEN_QUADVIEW_LORA, strength: 0.9 }]
  }
}

/** 步骤2b：不满意 → 编辑。千问用全能编辑；Krea2 用其四视图/编辑模板按指令改图 */
export function buildCharacterEditInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string,
  editPrompt: string,
  engine: ImageEngine = 'qwen'
): AssetJobInput | null {
  const prompt = (editPrompt || '').trim()
  if (!prompt || !refImage) return null
  if (engine === 'krea2') {
    // Krea2 用其四视图/编辑模板做图生图修改（grounded encode 承载指令）
    const template = pickFourViewTemplate(templates)
    if (!template) return null
    return {
      templateId: template.id,
      positive: prompt,
      negative: undefined,
      width: 0,
      height: 0,
      batch: 1,
      refImages: [refImage]
    }
  }
  const template = pickQwenEditTemplate(templates)
  if (!template) return null
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
