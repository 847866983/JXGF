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

/** 四视图结构负向词（配合固定提示词，抑制投影/地面/走形） */
const FOUR_VIEW_STRUCT_NEG =
  'multiple different characters, inconsistent design, different outfit between views, different face, extra heads, extra limbs, deformed, bad anatomy, blurry face, text, watermark, logo, signature, cropped, out of frame, low quality, chibi, super deformed, big head, oversized head, tiny body, short legs, childlike, doll, figurine, ' +
  'cast shadow, drop shadow, ground shadow, floor shadow, shadow on wall, shadow on background, floor, ground, floor line, horizon line, scenery, gradient background, spotlight, dramatic lighting, harsh light, vignette, ' +
  'fading edges, faded edges, ghosting, ghost image, translucent figure, semi-transparent figure, transparent figure, blurry edges, soft edges, white fade, white glow, overexposed, washed out'

/**
 * 四视图固定提示词（用户指定，原样发送，不拼接风格/描述）。
 * 用千问编辑模板 + 角色参考图，让模型把参考图转成四视图角色设定表。
 */
/** 四视图提示词（Krea2）：正面半身特写(脸部细节) + 正面/侧面/背面全身 */
export const FOUR_VIEW_PROMPT =
  'Convert the character in the image to a Character Sheet with four views arranged side by side on a plain pure white background: ' +
  'first a front upper-body half-body portrait showing the face clearly with detailed realistic facial features; ' +
  'then three full-body standing views — front view, side view and back view. ' +
  'Every full-body view shows the complete figure from head to feet, nothing cropped, whole body visible. ' +
  'Same character, same hairstyle, same outfit and colors in every view. ' +
  'Each figure fully opaque with sharp clean edges, crisp outlines, no fading, no ghosting.'

/** 兼容旧调用：四视图正向提示词固定为 FOUR_VIEW_PROMPT */
export function buildFourViewPositive(_desc?: string, _styleId?: string): string {
  return FOUR_VIEW_PROMPT
}

/** 四视图负向提示词：结构词 + 投影压制（styleId 省略时不加画风负词） */
export function fourViewNegative(_styleId?: string): string {
  // 只要结构负词（压制多角色/投影/渐变边），不掺任何画风负词
  return FOUR_VIEW_STRUCT_NEG
}

/**
 * 每种画风的**短标签**（中文）。千问这类强指令模型对提示词顺序敏感：
 * 前面塞一大段英文风格词，会把主体描述压掉，表现为「不按提示词生成」。
 * 所以用户写了提示词时，只用短标签做个后缀，主体永远是用户那句话。
 */
const SHORT_STYLE: Record<string, string> = {
  cg_real: '游戏CG写实风格，真实皮肤质感，电影级光影',
  real_photo: '电影剧照风格，真实摄影质感',
  cg_3d: '3D动画电影风格',
  anime: '动漫风格，干净线稿',
  ink_chinese: '国风水墨风格',
  comic_marvel: '美漫风格，粗描边'
}

/**
 * 单图正向提示词。
 *
 * **原样返回用户写的提示词**，不拼接任何画风词。
 * （旧实现会在前面塞一大段英文风格描述，千问这类强指令模型会被带偏，
 *   表现为「不按提示词生成」。）
 */
export function styledPositive(desc: string, _styleId?: string): string {
  return String(desc ?? '').trim()
}

/**
 * 按资产类型挑图片模板。
 *
 * 默认一律用**千问 Image 2.1 全能编辑**（用户指定：不要 Z-Image-Turbo）。
 * 找的顺序：千问 2.1 → 千问全能编辑 → 千问图片编辑 → 任意千问 → 第一个图片模板。
 */
export function pickAssetTemplate(templates: Template[], _kind?: AssetKind): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  if (imgs.length === 0) return undefined
  return pickQwenEditTemplate(imgs) ?? imgs[0]
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
  const picked = pickAssetTemplate(templates, asset.kind)
  if (!picked) return null
  const desc = asset.prompt || asset.description || asset.name || ''
  const isChar = asset.kind === 'character'
  // 角色生成走专用四视图模板；非千问引擎（如 Krea2）保持原模板不变。
  const template = isChar && /千问|Qwen/i.test(picked.name)
    ? pickQwenFourViewTemplate(templates) ?? picked
    : picked
  if (isChar) {
    // 角色统一用千问 Image 2.1：出四视图（<mva> 语法 + 多角度 LoRA）
    // 顺序很关键：<mva> 触发词 → 用户描述 → 结构说明。描述写在结构说明后面
    // 会被长段模板压掉，模型画出来就是个通用角色，不认你写的外貌。
    const QWEN_STRUCT = QWEN_QUADVIEW_PROMPT.replace(/^<mva>\s*/, '')
    const qwenPositive = `<mva> ${desc}\n\n${QWEN_STRUCT}`
    const isQwen = /千问|Qwen/i.test(template.name)
    return {
      templateId: template.id,
      positive: isQwen ? qwenPositive : buildFourViewPositive(desc, styleId),
      negative: isQwen ? fourViewNegative() : fourViewNegative(styleId),
      // 四视图 2000×1200（20261124 用户指定）；不开放大链——放大链会把
      // 四视图排版二次放大到 4000 宽，破坏面板结构。
      width: isQwen ? 2000 : FOUR_VIEW_W,
      height: isQwen ? 1200 : FOUR_VIEW_H,
      batch: 1,
      steps: isQwen ? 8 : undefined,
      loras: isQwen ? [{ file: QWEN_QUADVIEW_LORA, strength: 0.9 }] : undefined
    }
  }
  return {
    templateId: template.id,
    positive: styledPositive(desc, styleId),
    negative: asset.negative?.trim() || undefined,
    // 与 buildCharacterT2IInput 同口径：1024 原生，2K 交给放大链
    width: 1024,
    height: 1024,
    batch: 1
  }
}

// ---------- 角色资产生成（引擎：千问 / Krea2 / MOSS） ----------

/** 生图引擎。MOSS 仅支持纯文生图（模板无参考图通道），编辑/四视图请用千问或 Krea2 */
export type ImageEngine = 'qwen' | 'krea2' | 'moss'

/** 引擎显示名 */
export const ENGINE_LABEL: Record<ImageEngine, string> = {
  qwen: '千问 Qwen-Image 2.1',
  krea2: 'Krea2',
  moss: 'MOSS-Image'
}

/**
 * 引擎是否支持某模式。
 * 【20261125】千问重新接入文生图 + 25步编辑 + 四视图，三种模式全支持。
 */
export function engineSupports(engine: ImageEngine, mode: 't2i' | 'edit' | 'fourView'): boolean {
  if (engine === 'moss') return mode === 't2i'
  return true
}

/** 千问四视图多角度 LoRA（已下载到 models/loras） */
export const QWEN_QUADVIEW_LORA = 'qwen21_multiple_angles_v2.safetensors'

/** 千问四视图提示词：<mva> 触发 + 四视图描述（配合多角度 LoRA） */
export const QWEN_QUADVIEW_PROMPT =
  '<mva> Character reference sheet, exactly 4 panels in one horizontal row on a plain pure white background, all showing the same character: ' +
  'Panel 1 (leftmost): front-facing upper-body HALF-BODY portrait, waist up, face large and clearly visible with detailed realistic facial features, sharp focus on the face. ' +
  'Panel 2: full-body front view, complete figure from head to toe. ' +
  'Panel 3: full-body side view, complete figure from head to toe. ' +
  'Panel 4: full-body back view, complete figure from head to toe. ' +
  'All four panels are separate figures side by side, not overlapping. Same hairstyle, outfit and colors in every panel. ' +
  'Each figure fully opaque with sharp clean edges, crisp outlines, no fading, no ghosting, no cropping.'

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

/** Krea2 图片编辑模板（与四视图同族的 Edit 模型，但无 QuadView LoRA） */
export function pickKrea2EditTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return (
    imgs.find((t) => /Krea2/i.test(t.name) && /图片编辑|编辑/i.test(t.name) && !/四视图/i.test(t.name)) ||
    imgs.find((t) => /Krea2/i.test(t.name) && /edit/i.test(t.name) && !/四视图/i.test(t.name))
  )
}

/**
 * 【20261125 用户指令更新】千问文生图已用 D:/下载资源/Qwen-image21-文生图流.json 重新接入
 * （25 步全质量管线，QW21 好图同款）；编辑模板仍然删除，只留文生图 + 四视图。
 */
export function pickQwenT2ITemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return imgs.find((t) => /Qwen-image21-文生图/i.test(t.name))
}

/**
 * 【20261125 重新写】千问 25 步图片编辑模板（基于 25 步全质量文生图管线 + 原生
 * TextEncodeQwenImage21 的 images/vae 编辑路径）。绝不回退到四视图模板顶替。
 */
export function pickQwenEditTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return imgs.find((t) => /千问.*图片编辑.*25步|Qwen.*Edit.*25/i.test(t.name))
}

/** 千问角色四视图模板（默认挂多角度 LoRA）——千问引擎现在唯一的可用能力 */
export function pickQwenFourViewTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return imgs.find((t) => /千问.*四视图|Qwen.*四视图|Qwen.*four.?view|Qwen.*multi.?angle/i.test(t.name))
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
  if (engine === 'krea2') return pickKrea2T2ITemplate(templates)
  if (engine === 'moss') return pickMossTemplate(templates)
  return pickQwenT2ITemplate(templates)
}

/** MOSS-Image 文生图模板（纯文生图，不支持参考图） */
export function pickMossTemplate(templates: Template[]): Template | undefined {
  const imgs = templates.filter((t) => t.kind === 'image')
  return imgs.find((t) => /MOSS/i.test(t.name)) || imgs.find((t) => /moss/i.test(t.name))
}

/** 步骤1：文生图生成角色单图（不带参考图），支持千问 / Krea2 / MOSS 三引擎 */
export function buildCharacterT2IInput(
  asset: Asset,
  templates: Template[],
  _styleId?: string,
  engine: ImageEngine = 'qwen'
): AssetJobInput | null {
  const template = pickT2ITemplate(templates, engine)
  if (!template) return null
  const desc = asset.prompt || asset.description || asset.name || ''
  // MOSS 的出厂画布是 1184×896（qwen_data canvas），尊重模板设计不用方形。
  // 千问文生图保持 1024×1024 原生画布：实测 2048² 原生 4 步 turbo 会质量漂移
  // （体型变胖、画面发暗、8 分钟才出图，20261124 用户反馈）；2K 由 jobs 层的
  // 「放大链 2×」交付——与编辑同路径，画质与原口径一致、分辨率仍是 2K。
  const [w, h] = engine === 'moss' ? [1184, 896] : [1024, 1024]
  return {
    templateId: template.id,
    positive: desc,
    negative: asset.negative || undefined,
    width: w,
    height: h,
    batch: 1
  }
}

/** 步骤2a：满意 → 转四视图。Krea2 用现成四视图模板；千问用编辑+多角度LoRA；MOSS 不支持（返回 null） */
export function buildCharacterFourViewInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string,
  engine: ImageEngine = 'krea2'
): AssetJobInput | null {
  // MOSS 无参考图通道，做不了图生图四视图
  if (engine === 'moss') return null
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
  // 千问：专用四视图模板（内置多角度 LoRA）；没有时退回编辑模板
  const template = pickQwenFourViewTemplate(templates)
  if (!template || !refImage) return null
  return {
    templateId: template.id,
    positive: QWEN_QUADVIEW_PROMPT,
    negative: fourViewNegative(),
    // 四视图 2000×1200（20261124 用户指定），8 步 + 多角度 LoRA
    width: 2000,
    height: 1200,
    batch: 1,
    steps: 8,
    refImages: [refImage],
    loras: [{ file: QWEN_QUADVIEW_LORA, strength: 0.9 }]
  }
}

/** 步骤2b：不满意 → 编辑。千问用全能编辑；Krea2 用其四视图/编辑模板按指令改图；MOSS 不支持（返回 null） */
export function buildCharacterEditInput(
  asset: Asset,
  templates: Template[],
  styleId: string | undefined,
  refImage: string,
  editPrompt: string,
  engine: ImageEngine = 'qwen'
): AssetJobInput | null {
  // MOSS 无参考图通道，做不了指令编辑
  if (engine === 'moss') return null
  const prompt = (editPrompt || '').trim()
  if (!prompt || !refImage) return null
  // 按引擎选对应的编辑工作流（两套各自独立、功能对齐）：
  //   千问 → 千问图片编辑(全能编辑)
  //   Krea2 → 05-Krea2-图片编辑（Krea2 Edit 模型，无 QuadView LoRA，不会出四视图）
  const template = engine === 'krea2' ? pickKrea2EditTemplate(templates) ?? pickQwenEditTemplate(templates) : pickQwenEditTemplate(templates)
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
