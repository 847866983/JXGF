/**
 * H3 提示词与参考槽位规则 —— 对齐工作流节点包的
 * 「✍️ H3 文案台」(csglide_desk.py) 与「🎞️ H3 导演台」(csglide_cast.py)。
 *
 * 这个模块只做纯函数，不碰文件、不碰网络，方便单测。
 * ⚠️ 现状说明：仅 composeDeskText 进入生产链路（workflow.ts 引用）；
 * 其余导出为规则基线/机检用（selftest 校验节点包口径），删除会失去规格对齐能力。
 * 规则来源（两边必须一致，改一处要改另一处）：
 *   · 拼接：compose_text()          —— 片子级在前，本段在后，换行分隔
 *   · 归一：normalize_refs()        —— <Picture 1>/Picture 1/图片1 → @图片1 …
 *   · 粘连：_GLUE_RE                —— 相邻 @标签之间补一个空格
 *   · 摘除：_drop_unbacked_refs()   —— 没有素材的 @图片N 从文本里摘掉
 *   · 过滤：filterUsedByPrompt()    —— 只送提示词里提到过的槽位（音频除外）
 *   · 编号：build_tag_map()         —— @标签 → <Picture N>/<Video N>/<Audio N>
 */

export const H3_MAX_IMAGES = 9
export const H3_MAX_VIDEOS = 3
export const H3_MAX_AUDIOS = 3

/** 相邻 @标签之间补空格（与 Python/JS 的 _GLUE_RE 逐字一致） */
const GLUE_RE = /(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)/g

/** 空白清理：去掉行尾空格与多余空行（compose_text 的 _clean） */
export function cleanText(t: unknown): string {
  return String(t ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/**
 * 片子级 + 本段 = 最终提示词。
 *
 * 片子级在**前**：它是全片统一的风格/基调，本段是这一段要发生的事。
 * 反过来写会让每段的开头都在重复世界观，模型的注意力被拉到固定前缀上。
 */
export function composeDeskText(globalText: string, segText: string, sep = '\n'): string {
  const parts = [cleanText(globalText), cleanText(segText)].filter(Boolean)
  return glueRefs(parts.join(sep))
}

/** 相邻 @标签补空格（幂等） */
export function glueRefs(text: string): string {
  return String(text ?? '').replace(GLUE_RE, '$1 ')
}

/* ------------------------------------------------------------------ 归一化 */

const REF_ALIASES: [RegExp, string][] = [
  [/<\s*Picture\s*(\d+)\s*>/gi, '@图片$1'],
  [/<\s*Video\s*(\d+)\s*>/gi, '@视频$1'],
  [/(?<!@)\bPictures?\s*(\d+)(?!\d)/gi, '@图片$1'],
  [/(?<!@)\bImages?\s*(\d+)(?!\d)/gi, '@图片$1'],
  [/(?<!@)\bVideos?\s*(\d+)(?!\d)/gi, '@视频$1'],
  [/(?:@\s*)?视频音频\s*(\d+)(?!\d)/g, '@视频音频$1'],
  [/(?<![视音频图])(?:@\s*)?(?:图片|图像)\s*(\d+)(?!\d)/g, '@图片$1'],
  [/(?<![视音频图])(?:@\s*)?视频\s*(\d+)(?!\d)/g, '@视频$1'],
  [/(?<![视音频图])(?:@\s*)?音频\s*(\d+)(?!\d)/g, '@音频$1']
]

const AUDIO_TAG_RE = /<\s*Audio\s*(\d+)\s*>/gi
const AUDIO_WORD_RE = /(?<!@)\bAudios?\s*(\d+)(?!\d)/gi

/**
 * 把各种写法统一成规范 @标签。
 * `<Picture 1>` / `Picture 1` / `Image 1` / `图片1` / `图像 1` → `@图片1`
 * `<Video 2>` / `Video 2` / `视频2`             → `@视频2`
 * `<Audio 1>` / `Audio 1`                       → `@音频1`
 * `视频音频3`                                    → `@视频音频3`
 */
export function normalizeRefs(text: string): string {
  let out = String(text ?? '')
  // 音频先处理：放到中文规则之后会再被「视频音频」规则碾一遍
  out = out.replace(AUDIO_TAG_RE, (m, n: string) => {
    const i = Number(n)
    return i >= 1 && i <= H3_MAX_AUDIOS ? `@音频${i}` : m
  })
  out = out.replace(AUDIO_WORD_RE, (m, n: string) => {
    const i = Number(n)
    return i >= 1 && i <= H3_MAX_AUDIOS ? `@音频${i}` : m
  })
  for (const [pat, rep] of REF_ALIASES) out = out.replace(pat, rep)
  return glueRefs(out)
}

/* ------------------------------------------------------------------ 槽位 */

export interface RefSlot {
  file?: string
  alias?: string[]
  start?: number
  end?: number
  dur?: number
  audio?: boolean
}

export interface H3Slots {
  first?: RefSlot
  last?: RefSlot
  images?: RefSlot[]
  videos?: RefSlot[]
  audios?: RefSlot[]
}

export function emptySlots(): Required<H3Slots> {
  return {
    first: {},
    last: {},
    images: Array.from({ length: H3_MAX_IMAGES }, () => ({})),
    videos: Array.from({ length: H3_MAX_VIDEOS }, () => ({})),
    audios: Array.from({ length: H3_MAX_AUDIOS }, () => ({}))
  }
}

/** refs 里**真有文件**的标签集合（编号 = 槽位位置，1 起） */
export function providedRefs(slots: H3Slots): Set<string> {
  const out = new Set<string>()
  if (slots.first?.file) out.add('@first')
  if (slots.last?.file) out.add('@last')
  ;(slots.images ?? []).forEach((s, i) => {
    if (s?.file) out.add(`@图片${i + 1}`)
  })
  ;(slots.videos ?? []).forEach((s, i) => {
    if (!s?.file) return
    out.add(`@视频${i + 1}`)
    if (s.audio) out.add(`@视频音频${i + 1}`)
  })
  ;(slots.audios ?? []).forEach((s, i) => {
    if (s?.file) out.add(`@音频${i + 1}`)
  })
  return out
}

const ANY_REF_RE = /@(?:图片|音频|视频)\d+/g

/**
 * 把「没有对应参考素材」的编号从文本里摘掉。
 * 悬空编号会让模型以为有素材、照着写引用，画面失控。
 * 配套的「改成文字描述」：`@图片1中的小明` → `中的小明`，模型按其上下文描述。
 */
export function dropUnbackedRefs(
  text: string,
  slots: H3Slots
): { text: string; dropped: string[] } {
  if (!text) return { text, dropped: [] }
  const have = providedRefs(slots)
  const found = new Set(text.match(ANY_REF_RE) ?? [])
  const dropped = [...found].filter((r) => !have.has(r)).sort()
  if (dropped.length === 0) return { text, dropped: [] }
  let out = text
  for (const r of dropped) out = out.split(r).join('')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return { text: out, dropped }
}

/**
 * 严格按需：提示词提到的 @标签 才送素材，一个都没提就一个都不送。
 * 未提到的位置保留为 null —— 编号位置不变（@图片2 仍是第 2 槽）。
 * 独立音频不过滤（与节点包同口径）：配乐/音色是整体氛围参考，剧本里未必逐句提到。
 */
export function filterSlotsByPrompt(slots: H3Slots, prompt: string): H3Slots {
  const nums = (re: RegExp): Set<number> =>
    new Set([...prompt.matchAll(re)].map((m) => Number(m[1]) - 1))
  const keep = {
    images: nums(/@图片(\d+)/g),
    videos: new Set([...nums(/@视频音频(\d+)/g), ...nums(/@视频(\d+)/g)]),
    audios: nums(/@音频(\d+)/g)
  }
  const caps = { images: H3_MAX_IMAGES, videos: H3_MAX_VIDEOS, audios: H3_MAX_AUDIOS }
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) {
    if (keep[k].size > caps[k]) {
      keep[k] = new Set([...keep[k]].sort((a, b) => a - b).slice(0, caps[k]))
    }
  }
  const any = Object.values(keep).some((s) => s.size > 0)
  const out: H3Slots = { first: slots.first, last: slots.last }
  for (const k of ['images', 'videos', 'audios'] as const) {
    const arr = slots[k] ?? []
    if (k === 'audios') {
      const all = arr.map((s, i) => (s?.file ? i : -1)).filter((i) => i >= 0)
      const use = new Set(all.slice(0, H3_MAX_AUDIOS))
      out[k] = arr.map((s, i) => (use.has(i) ? s : {}))
      continue
    }
    out[k] = any ? arr.map((s, i) => (keep[k].has(i) ? s : {})) : []
  }
  return out
}

export interface PresentationRow {
  tag: string
  token: string
  from: string
  kind: 'image' | 'video' | 'audio'
}

/**
 * @标签 → 模型认识的标签。编号规则（与 build_tag_map 逐条一致）：
 * 图片先排；视频自带的声音 <Audio j> 紧挨在它的 <Video k> 之前；独立音频最后。
 * 每种类型各自 1 起编号，只数**已填**的槽位。
 */
export function presentationOrder(slots: H3Slots, mode: string): PresentationRow[] {
  const rows: PresentationRow[] = []
  if (mode === 'fl2va') {
    let i = 0
    if (slots.first?.file) {
      i += 1
      rows.push({ tag: `<Picture ${i}>`, token: '@first', from: 'first frame', kind: 'image' })
    }
    if (slots.last?.file) {
      i += 1
      rows.push({ tag: `<Picture ${i}>`, token: '@last', from: 'last frame', kind: 'image' })
    }
    return rows
  }
  let i = 0
  let j = 0
  let k = 0
  ;(slots.images ?? []).forEach((s, n) => {
    if (!s?.file) return
    i += 1
    rows.push({ tag: `<Picture ${i}>`, token: `@图片${n + 1}`, from: `图片 ${n + 1}`, kind: 'image' })
  })
  ;(slots.videos ?? []).forEach((s, n) => {
    if (!s?.file) return
    if (s.audio) {
      j += 1
      rows.push({ tag: `<Audio ${j}>`, token: `@视频音频${n + 1}`, from: `视频 ${n + 1} 声音`, kind: 'audio' })
    }
    k += 1
    rows.push({ tag: `<Video ${k}>`, token: `@视频${n + 1}`, from: `视频 ${n + 1}`, kind: 'video' })
  })
  ;(slots.audios ?? []).forEach((s, n) => {
    if (!s?.file) return
    j += 1
    rows.push({ tag: `<Audio ${j}>`, token: `@音频${n + 1}`, from: `音频 ${n + 1}`, kind: 'audio' })
  })
  return rows
}

/* ------------------------------------------------------------------ 画布 */

export const H3_FPS = 24
/** 帧数必须落在 17k+5 网格上（向上吸附） */
export function alignFrames(n: number): number {
  let v = Math.max(5, Math.round(n))
  while (v % 17 !== 5) v += 1
  return v
}
/** 最近的 17k+5 帧（自定义时长按秒吸附用） */
export function nearestFrames(n: number): number {
  return 5 + 17 * Math.max(0, Math.round((Math.max(5, Math.round(n)) - 5) / 17))
}
