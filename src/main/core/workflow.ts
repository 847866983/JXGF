import type { Template, UpscaleSettings, RifeSettings } from '@shared/types'
import { sanitizeOutputName } from './output-files.ts'
import { composeDeskText } from './h3-prompt.ts'

export interface WorkflowParams {
  /** 片子级提示词（文案台 global）：全片统一风格，拼在本段提示词前面 */
  globalPrompt?: string
  positive?: string
  negative?: string
  width?: number
  height?: number
  frames?: number
  seed?: number
  /** 每批生成张数（图片批量出图用） */
  batch?: number
  /** 采样器细参（视频/图片生成共用） */
  steps?: number
  cfg?: number
  samplerName?: string
  scheduler?: string
  /** 采样参数与模板一致时为 true：不重算 SelfLift 分段步数，保留作者原配 */
  keepTemplateSampler?: boolean
  /** 生成模式：t2v（文生视频）/ fl2va（首尾帧）/ ref2va（参考图生视频） */
  mode?: 't2v' | 'fl2va' | 'ref2va'
  /** 分段导演台：覆盖 h3_data 的字段（ratio、pin_head、ref_* 、bridge_* 、cont、push_whole、chain） */
  h3?: Record<string, unknown>
  /** 放大重绘参数 */
  upscale?: UpscaleSettings
  /** 抽帧 / 插帧参数 */
  rife?: RifeSettings
  /** 参考图（图片编辑/图生图用；视频的参考图走媒体架） */
  refImages?: string[]
  /** 需要挂载的 LoRA（如千问多角度四视图） */
  loras?: { file: string; strength: number }[]
}

type WorkflowNode = { id: string; class_type: string; inputs: Record<string, unknown>; title?: string }
type Workflow = Record<string, WorkflowNode>

function isWorkflowObject(v: unknown): v is Record<string, WorkflowNode> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function textNodeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inputs)) {
    if (k === 'text' || /prompt|text/i.test(k)) out[k] = v
  }
  return out
}

interface DeskData {
  chain?: { name?: string; clip?: string; shot?: string }
  global?: string
  segs?: Record<string, string>
}

interface H3Data {
  mode?: string
  width?: number
  height?: number
  length?: number
  prompt?: string
  /** 参考素材槽：{ first, last, images[], videos[], audios[] }，真正喂给模型的字段 */
  slots?: Record<string, unknown>
  [k: string]: unknown
}

function tryParse<T>(v: unknown): T | null {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/**
 * 千问图片编辑（CSGlideQwenCastCS）：把提示词/负面/画布写进 qwen_data。
 * 参考图走同一工作流的 CSGlideH3MediaRackCS（rack_data.slots.images）。
 */
interface QwenData {
  prompt?: string
  negative_prompt?: string
  canvas?: { w?: number; h?: number }
  canvas_from_ref?: boolean
  [k: string]: unknown
}

/** 千问图片编辑节点名（不同版本叫法不同）：CSGlideImageCastCS 是当前版本，CSGlideQwenCastCS 是旧版 */
const QWEN_EDIT_NODES = ['CSGlideImageCastCS', 'CSGlideQwenCastCS']

function isQwenEditNode(classType: string): boolean {
  return QWEN_EDIT_NODES.includes(classType)
}

function injectQwenEdit(clone: Workflow, params: WorkflowParams): void {
  const hasRefs = Array.isArray(params.refImages) && params.refImages.length > 0
  for (const node of Object.values(clone)) {
    if (!isQwenEditNode(String(node.class_type))) continue
    const raw = node.inputs.qwen_data
    const data = tryParse<QwenData>(typeof raw === 'string' ? raw : '')
    if (!data) continue
    if (params.positive) data.prompt = params.positive
    if (params.negative) data.negative_prompt = params.negative
    // 有参考图时画布跟随参考图（编辑模式最自然）；显式给了宽高才用它
    if (hasRefs && !(params.width && params.height)) {
      data.canvas_from_ref = true
    } else if (params.width && params.height) {
      data.canvas_from_ref = false
      data.canvas = { ...(data.canvas ?? {}), w: params.width, h: params.height }
    }
    node.inputs.qwen_data = JSON.stringify(data)
  }
}

/**
 * 音乐工作流提示词注入（只改提示词，不动任何生成参数）。
 *
 * 覆盖两种节点：
 *   - ACE Step 1.5：TextEncodeAceStepAudio1.5，提示词在 `tags`（索引 1）
 *   - YuE2 乐谱：BanZhang_LyricsInput（title 含「风格」/「歌词」），提示词在 widgets[0]
 *
 * 返回 true 表示命中过音乐节点。
 */
function injectMusicPrompt(clone: Workflow, positive: string): boolean {
  if (!positive) return false
  let hit = false
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    // ACE Step：tags 是风格/标签描述，就是用户写的提示词
    if (/TextEncodeAceStepAudio/i.test(ct)) {
      if (typeof node.inputs.tags === 'string') {
        node.inputs.tags = positive
        hit = true
      }
      continue
    }
    // YuE2：歌词/风格输入节点，text_in 承载文本
    if (/BanZhang_LyricsInput/i.test(ct)) {
      const title = String(node.title ?? '')
      // 只写「风格」节点；「歌词」和「ABC」由工作流自己的 LLM 规划，不覆盖
      if (/风格/.test(title) && typeof node.inputs.text_in === 'string') {
        node.inputs.text_in = positive
        hit = true
      }
      continue
    }
    // YuE2 智能规划节点：style 字段
    if (/BanzhangYuE2SmartPlan/i.test(ct)) {
      for (const key of Object.keys(node.inputs)) {
        if (typeof node.inputs[key] !== 'string') continue
        const data = tryParse<Record<string, unknown>>(node.inputs[key] as string)
        if (data && typeof data === 'object' && 'plan_mode' in data) {
          data.style = positive
          node.inputs[key] = JSON.stringify(data)
          hit = true
          break
        }
      }
    }
  }
  return hit
}

/**
 * 找到节点里存放 h3_data 的字段名（不同版本叫法不同：h3_data 或 first_frame）。
 */
function h3DataField(node: WorkflowNode): string | null {
  for (const key of ['h3_data', 'first_frame']) {
    if (typeof node.inputs[key] === 'string') return key
  }
  return null
}

/**
 * 找到节点里存放 desk_data 的字段名（desk_data 或「外接提示词」）。
 */
function deskDataField(node: WorkflowNode): string | null {
  for (const key of ['desk_data', '外接提示词', '外接提示词 ']) {
    if (typeof node.inputs[key] === 'string') return key
  }
  return null
}

/**
 * 把 MiniMax-H3 工作流的提示词写进 CSGlideCastCS 的 h3_data.prompt。
 *
 * 提示词口径照搬「✍️ H3 文案台」：
 *   片子级（全片风格/基调） + 本段（这一段发生的事） = 最终提示词
 * 片子级在前 —— 反过来写会让每段开头都重复世界观，段与段的差别被稀释。
 */
export function injectH3Prompt(clone: unknown, positive: string, globalPrompt = ''): boolean {
  if (!isWorkflowObject(clone)) return false
  // 文案台的 compose_text：片子级 + 本段
  const finalPrompt = composeDeskText(globalPrompt, positive)
  // ① 关键：写进 CSGlideCastCS.h3_data.prompt —— 这是真正驱动画面的提示词字段。
  //    之前只写 desk_data.segs 导致 h3_data.prompt 一直为空，模型用了模板残留内容。
  let wroteCast = false
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<H3Data>(node.inputs[field])
    if (!h3) continue
    h3.prompt = finalPrompt
    node.inputs[field] = JSON.stringify(h3)
    // 关键：断开 prompt_text 的连线（模板里接 DeskCS 输出[1]，其内容为空/残留），
    // 改为直接字符串提示词，确保模型真正收到本次提示词。
    // 节点输入的键名随版本变过：英文 prompt_text / 中文「外接提示词」都写一遍
    if ('prompt_text' in node.inputs) node.inputs.prompt_text = finalPrompt
    if ('外接提示词' in node.inputs) node.inputs['外接提示词'] = finalPrompt
    // h3_override 若存在也写，避免旧覆盖值干扰
    if (typeof node.inputs.h3_override === 'string') node.inputs.h3_override = finalPrompt
    if (typeof node.inputs['🎛️ 外接导演配置'] === 'string') node.inputs['🎛️ 外接导演配置'] = finalPrompt
    wroteCast = true
  }
  // ② 同时写进 CSGlideDeskCS.desk_data（文案台自己的存档：global = 片子级，segs = 本段）
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideDeskCS') continue
    const field = deskDataField(node)
    if (!field) continue
    const desk = tryParse<DeskData>(node.inputs[field])
    if (!desk) continue

    const clip = desk.chain?.clip ?? 'clip_0001'
    desk.segs = desk.segs ?? {}
    desk.segs[clip] = positive
    // global 是**片子级**提示词（全片统一风格），不是本段词 ——
    // 以前把本段词抄进 global，等于把这一段的内容当成整片基调，
    // 且文案台按 global+seg 拼接时会重复一遍。
    desk.global = globalPrompt
    if (desk.chain) desk.chain.shot = clip
    node.inputs[field] = JSON.stringify(desk)
  }
  return wroteCast
}

/**
 * 注入 H3 的尺寸 / 帧数 / 模式到 CSGlideCastCS 的 h3_data（或 first_frame）。
 */
function injectH3Data(clone: Workflow, params: WorkflowParams): void {
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<H3Data>(node.inputs[field])
    if (!h3) continue
    if (params.width) h3.width = params.width
    if (params.height) h3.height = params.height
    if (params.frames) h3.length = params.frames
    if (params.mode) h3.mode = params.mode
    // 别名模式：文案台的「别名」开关显式传了就用它，否则默认开启
    // （H3 才会把提示词里的资产名/角色名展开成 @图片N → <Picture N>）
    h3.alias = params.h3?.alias === false ? false : true
    // 分段导演台覆盖字段（画布比例/保留头尾/参考/语义桥/续接/整片潜空间/链身份）
    if (params.h3) {
      for (const [k, v] of Object.entries(params.h3)) {
        if (v !== undefined) h3[k] = v
      }
    }
    // 只清 cont（续拍存档路径残留，避免续到错误的上次 latent）。
    // 但分段导演台显式传入 cont（续接）时必须保留。
    const contExplicit = params.h3 ? Object.prototype.hasOwnProperty.call(params.h3, 'cont') : false
    if (h3.cont && !contExplicit) delete h3.cont
    node.inputs[field] = JSON.stringify(h3)
  }
}

/**
 * t2v 模式下清空参考图残留：媒体架 rack_data、VisualLoader 指定文件。
 * ref2va / fl2va 模式才需要参考图，t2v 需要干净输入，否则主链路会短路。
 */
function clearH3Refs(clone: Workflow, mode?: string): void {
  if (mode !== 't2v') return
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (ct === 'CSGlideH3MediaRackCS' && typeof node.inputs.rack_data === 'string') {
      const rack = tryParse<Record<string, unknown>>(node.inputs.rack_data)
      if (rack) {
        rack.slots = { images: [], videos: [], audios: [] }
        if (rack.segs && typeof rack.segs === 'object') {
          const segs = rack.segs as Record<string, unknown>
          for (const key of Object.keys(segs)) {
            const s = segs[key] as Record<string, unknown>
            if (s && typeof s === 'object') s.slots = { images: [], videos: [], audios: [] }
          }
        }
        node.inputs.rack_data = JSON.stringify(rack)
      }
    }
    if (ct === 'H3VisualLoader' && '📄 指定文件' in node.inputs) {
      node.inputs['📄 指定文件'] = ''
    }
  }
}

/**
 * 把素材写入 H3 媒体架 rack_data。
 *
 * rack_data 有两层 slots：
 *   顶层 slots（媒体架面板显示用）
 *   segs[cur].slots（当前段实际读取的槽位）
 * H3 运行时按 segs[cur] 取素材，只写顶层不生效，所以两处都要写。
 *
 * alias 是槽位称呼：H3 会把提示词里出现的 alias 自动展开成 @图片N，
 * 所以把资产名写进 alias，提示词里写角色名即可绑定这张参考图。
 */
function writeRackSlots(
  rack: Record<string, unknown>,
  kind: 'images' | 'videos' | 'audios',
  files: string[],
  aliases?: string[]
): void {
  const entries = files.map((f, i) => {
    const a = aliases?.[i]?.trim()
    return { file: f, alias: a ? [a] : [f] }
  })
  // 顶层 slots
  const top = (rack.slots as Record<string, unknown> | undefined) ?? {}
  top[kind] = entries
  rack.slots = top
  // 当前段的 slots（H3 实际读取这里）
  const segs = rack.segs as Record<string, Record<string, unknown>> | undefined
  const cur = typeof rack.cur === 'string' ? rack.cur : undefined
  if (segs && typeof segs === 'object') {
    const keys = cur && segs[cur] ? [cur] : Object.keys(segs)
    for (const key of keys) {
      const seg = segs[key]
      if (!seg || typeof seg !== 'object') continue
      const s = (seg.slots as Record<string, unknown> | undefined) ?? {}
      s[kind] = entries.map((e) => ({ file: e.file, alias: [...e.alias] }))
      seg.slots = s
    }
  }
}

/**
 * 把素材写入 CSGlideCastCS 的 h3_data.slots —— 这是真正喂给模型的槽位。
 * h3_data.slots 结构：{ first:{}, last:{}, images:[{},{},...], videos:[...], audios:[...] }
 * 模板里 images/videos/audios 是预置的占位数组（长度固定），必须按索引填 file。
 */
function writeCastSlots(
  h3: H3Data,
  kind: 'images' | 'videos' | 'audios',
  files: string[],
  aliases?: string[]
): void {
  const aliasOf = (f: string, i: number): string[] => {
    const a = aliases?.[i]?.trim()
    return a ? [a] : [f]
  }
  const slots = (h3.slots as Record<string, unknown> | undefined) ?? {}
  const exist = slots[kind]
  if (Array.isArray(exist)) {
    // 按模板占位数组长度填，多余的清空，未用的保留空对象
    const next = exist.map((old, i) => {
      const f = files[i]
      if (!f) return {}
      const base = old && typeof old === 'object' ? { ...(old as Record<string, unknown>) } : {}
      return { ...base, file: f, alias: aliasOf(f, i) }
    })
    // 超出占位长度的丢弃（H3 只读模板固定槽位数）
    slots[kind] = next
  } else {
    slots[kind] = files.map((f, i) => ({ file: f, alias: aliasOf(f, i) }))
  }
  h3.slots = slots
}

/**
 * 在提示词里补上参考素材的 @ 引用标签。
 *
 * H3 的绑定机制（见 Banzhang csglide_cast.py）：
 *   提示词里写 @图片1 / @视频1 / @音频1，节点会转写成 <Picture 1> / <Video 1> / <Audio 1>，
 *   并按实际填充的槽位重新编号。**提示词里没有 @ 引用，模型就完全不会用参考图。**
 *
 * 注意：槽位 alias 里存了资产名，H3 会把提示词中出现的资产名也展开成 @图片N。
 * 所以这里只补 @图片N，**不附带资产名**——否则「@图片1（安洁拉）」会被展开成
 * 「<Picture 1>（<Picture 1>）」，模型拿到的是自我指涉的编号，反而丢掉角色语义。
 *
 * 返回补好引用的提示词；已有 @图片N 时不重复插入。
 */
export function appendRefTags(prompt: string, refImages: string[]): string {
  if (refImages.length === 0) return prompt
  const text = prompt ?? ''
  const tags: string[] = []
  for (let i = 0; i < refImages.length; i++) {
    const tag = `@图片${i + 1}`
    // 提示词里已显式写过这个标签（或写过 <Picture N>）就不重复加
    if (text.includes(tag) || new RegExp(`<\\s*Picture\\s*${i + 1}\\s*>`, 'i').test(text)) continue
    tags.push(tag)
  }
  if (tags.length === 0) return text
  // 追加到提示词末尾：只写 @图片N，不附资产名（否则会被 alias 二次展开成自我指涉）
  return `${text}\n\n参考素材：${tags.join('、')}`
}

/**
 * 把参考图文件名注入 H3 媒体架（CSGlideH3MediaRackCS 的 rack_data）。
 * refImages 是已上传到 ComfyUI input 的文件名（如 cglide/xxx.png）。
 * aliases 是对应的称呼（通常传资产名），写进槽位 alias 供提示词绑定。
 */
export function injectH3RefImages(clone: unknown, refImages: string[], aliases?: string[]): void {
  if (refImages.length === 0) return
  if (!isWorkflowObject(clone)) return
  // Krea2 图生图：把参考图写进 LoadImage 节点（上传后的文件名）
  const hasKrea2 = Object.values(clone).some((n) => /Krea2EditGroundedEncode|Krea2EditModelPatch/i.test(String(n.class_type)))
  if (hasKrea2) {
    for (const node of Object.values(clone)) {
      if (String(node.class_type) === 'LoadImage') {
        node.inputs.image = refImages[0]
      }
    }
    return
  }
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    // ① 媒体架：顶层 + 当前段两层都写
    if (ct === 'CSGlideH3MediaRackCS') {
      const raw = node.inputs.rack_data
      if (typeof raw !== 'string') continue
      const rack = tryParse<Record<string, unknown>>(raw)
      if (!rack) continue
      writeRackSlots(rack, 'images', refImages, aliases)
      node.inputs.rack_data = JSON.stringify(rack)
    }
    // ② CSGlideCastCS.h3_data.slots：真正喂给模型的槽位
    if (ct === 'CSGlideCastCS') {
      const field = h3DataField(node)
      if (!field) continue
      const h3 = tryParse<H3Data>(node.inputs[field])
      if (!h3) continue
      writeCastSlots(h3, 'images', refImages, aliases)
      node.inputs[field] = JSON.stringify(h3)
    }
  }
}

/**
 * 视频参考：把上传后的参考视频写入 H3 媒体架（slots.videos）与 h3_data.slots。
 */
export function injectH3RefVideos(clone: unknown, refVideos: string[], aliases?: string[]): void {
  if (refVideos.length === 0) return
  if (!isWorkflowObject(clone)) return
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (ct === 'CSGlideH3MediaRackCS') {
      const raw = node.inputs.rack_data
      if (typeof raw !== 'string') continue
      const rack = tryParse<Record<string, unknown>>(raw)
      if (!rack) continue
      writeRackSlots(rack, 'videos', refVideos, aliases)
      node.inputs.rack_data = JSON.stringify(rack)
    }
    if (ct === 'CSGlideCastCS') {
      const field = h3DataField(node)
      if (!field) continue
      const h3 = tryParse<H3Data>(node.inputs[field])
      if (!h3) continue
      writeCastSlots(h3, 'videos', refVideos, aliases)
      node.inputs[field] = JSON.stringify(h3)
    }
  }
}

/**
 * 同步 CSGlideDeskCS 的 chain/clip 与 CSGlideCastCS.h3_data.chain 一致，
 * 并把 desk_data.segs 里旧 clip 的提示词迁到新 clip，保证提示词挂到正确的段。
 */
function syncH3DeskChain(clone: Workflow): void {
  let h3chain: { name?: string; clip?: string; shot?: string } | null = null
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<{ chain?: { name?: string; clip?: string; shot?: string } }>(node.inputs[field])
    if (h3?.chain?.name) h3chain = h3.chain
  }
  if (!h3chain?.name) return

  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'CSGlideDeskCS') continue
    const field = deskDataField(node)
    if (!field) continue
    const desk = tryParse<DeskData>(node.inputs[field])
    if (!desk) continue
    const oldClip = desk.chain?.clip
    const newClip = h3chain.clip || oldClip
    desk.segs = desk.segs ?? {}
    if (oldClip && newClip && oldClip !== newClip && desk.segs[oldClip] !== undefined) {
      desk.segs[newClip] = desk.segs[oldClip]
      delete desk.segs[oldClip]
    }
    desk.chain = { name: h3chain.name, clip: newClip, shot: h3chain.shot }
    node.inputs[field] = JSON.stringify(desk)
  }
}

/**
 * 放大重绘参数注入（BanZhang_MMH3_Upscale / UpscaleParams）。
 */
function applyUpscaleParams(clone: Workflow, up: UpscaleSettings): void {
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    const i = node.inputs
    if (ct === 'BanZhang_MMH3_Upscale') {
      // 关键：这些节点即使"关闭放大"仍在链路中执行，去噪强度=0 会导致 steps/denoise 除零。
      // 关闭时保留安全默认值，绝不写 0。
      const steps = Math.max(1, Number(up.steps) || 2)
      const denoise = Math.max(0.05, Number(up.denoise) || 0.45)
      const audioDenoise = Math.max(0.05, Number(up.audioDenoise) || 0.3)
      if ('步数' in i) i['步数'] = steps
      if ('去噪强度' in i) i['去噪强度'] = denoise
      if ('音频重绘强度' in i) i['音频重绘强度'] = audioDenoise
      if ('采样器' in i && up.sampler) i['采样器'] = up.sampler
      if ('调度器' in i && up.scheduler) i['调度器'] = up.scheduler
    } else if (ct === 'BanZhang_MMH3_UpscaleParams') {
      if ('放大模式' in i) i['放大模式'] = up.enabled ? up.mode : '按倍数'
      if ('放大倍数' in i) i['放大倍数'] = up.enabled ? Math.max(1, up.scale) : 1
      if ('目标宽度' in i) i['目标宽度'] = up.targetWidth
      if ('目标高度' in i) i['目标高度'] = up.targetHeight
      if ('每块帧数' in i) i['每块帧数'] = up.tileFrames
      if ('重叠帧数' in i) i['重叠帧数'] = up.overlapFrames
    }
  }
}

/**
 * 抽帧 / 插帧参数注入（BanZhang_RIFE_Interpolation）。
 */
function applyRifeParams(clone: Workflow, rife: RifeSettings): void {
  for (const node of Object.values(clone)) {
    if (String(node.class_type) !== 'BanZhang_RIFE_Interpolation') continue
    const i = node.inputs
    if ('插帧倍数' in i) i['插帧倍数'] = rife.enabled ? rife.multiplier : 1
    if ('序列源帧率' in i) i['序列源帧率'] = rife.fps
    if ('保留原音' in i) i['保留原音'] = rife.keepAudio ? '开' : '关'
  }
}

/**
 * 通用采样器细参注入：对 KSampler / KSamplerAdvanced 设置 steps/cfg/sampler_name/scheduler。
 * 放在 H3 参数修正之前，这样 SelfLift 分段步数能按新 steps 对齐。
 */
function applySamplerParams(clone: Workflow, params: WorkflowParams): void {
  for (const node of Object.values(clone)) {
    if (!/^KSampler(Advanced)?$/.test(String(node.class_type))) continue
    const i = node.inputs
    if (params.steps !== undefined && 'steps' in i) i.steps = params.steps
    if (params.cfg !== undefined && 'cfg' in i) i.cfg = params.cfg
    if (params.samplerName && 'sampler_name' in i) i.sampler_name = params.samplerName
    if (params.scheduler && 'scheduler' in i) i.scheduler = params.scheduler
    if (params.seed !== undefined && 'seed' in i) i.seed = params.seed
  }
}

/**
 * 把模板（API 格式）与镜头参数合成最终提交给 ComfyUI 的工作流。
 *
 * 采用「探测式注入」，节点 ID 永不写死：
 * - 若模板含 CSGlideDeskCS / CSGlideCastCS（MiniMax-H3），走 H3 专用注入；
 * - 否则回退到通用 CLIPTextEncode / EmptyLatentImage 注入。
 */
export function buildWorkflow(template: Template, params: WorkflowParams): unknown {
  if (!isWorkflowObject(template.apiJson)) {
    throw new Error('模板不是有效的 API 工作流（缺少 nodes 结构）')
  }
  const clone: Workflow = JSON.parse(JSON.stringify(template.apiJson)) as Workflow

  // UI→API 转换器可能产出没有 inputs 的节点（Reroute / Note / 占位节点）。
  // 后面几十处都写 `'x' in node.inputs`，缺一个就会抛
  // 「Cannot use 'in' operator to search for 'frames' in undefined」把整次生成打断。
  // 统一补空对象，比在每个循环里各加一道守卫可靠。
  for (const node of Object.values(clone)) {
    if (node && typeof node === 'object' && (!node.inputs || typeof node.inputs !== 'object')) {
      node.inputs = {}
    }
  }

  // 先注入采样器细参（steps/cfg/sampler/scheduler），H3 的 SelfLift 会据此对齐
  applySamplerParams(clone, params)

  // 挂载 LoRA（如千问多角度四视图）——放在所有分支之前，确保各路径都生效
  if (Array.isArray(params.loras) && params.loras.length > 0) {
    for (const node of Object.values(clone)) {
      const ct = String(node.class_type)
      if (!/BanZhang_LoRA_VramSafe|LoraLoaderModelOnly|LoraLoader/i.test(ct)) continue
      const first = params.loras[0]
      if ('LoRA文件' in node.inputs) node.inputs['LoRA文件'] = first.file
      if ('lora_name' in node.inputs) node.inputs.lora_name = first.file
      if ('模型强度' in node.inputs) node.inputs['模型强度'] = String(first.strength)
      if ('strength_model' in node.inputs) node.inputs.strength_model = first.strength
    }
  }

  const hasQwenEdit = Object.values(clone).some((n) => isQwenEditNode(String(n.class_type)))
  const isH3 = Object.values(clone).some((n) => String(n.class_type).includes('CSGlide'))

  // 千问图片编辑：提示词/负面/画布写进 qwen_data（参考图由 jobs 上传后注入媒体架）
  if (hasQwenEdit) {
    injectQwenEdit(clone, params)
    if (params.seed !== undefined) {
      for (const node of Object.values(clone)) {
        if (/^KSampler(Advanced)?$/.test(String(node.class_type)) && 'seed' in node.inputs) {
          node.inputs.seed = params.seed
        }
      }
    }
    return clone
  }

  if (isH3) {
    if (params.positive !== undefined) {
      injectH3Prompt(clone, params.positive, params.globalPrompt ?? '')
    }
    injectH3Data(clone, params)
    syncH3DeskChain(clone)
    if (params.upscale) applyUpscaleParams(clone, params.upscale)
    if (params.rife) applyRifeParams(clone, params.rife)
    // 生成模式可能只通过 h3.mode 传入（导演台），t2v 时必须清空参考图残留
    const effMode = (params.h3?.mode as string | undefined) ?? params.mode
    clearH3Refs(clone, effMode)
    // 注意：SelfLift「分段步数」保持工作流作者原配，不自动改写。
    // 若步数与 KSampler steps 不匹配，由 ComfyUI 节点自己报错提示，软件不静默改配置。
    // H3 的种子在 KSampler 节点
    if (params.seed !== undefined) {
      for (const node of Object.values(clone)) {
        if (String(node.class_type) === 'KSampler' && 'seed' in node.inputs) {
          node.inputs.seed = params.seed
        }
      }
    }
    return clone
  }

  // Krea2 图生图模板（04-Krea2-角色资产四视图）：
  //   - LoadImage 节点加载参考图（用户选中的角色图）
  //   - Krea2EditGroundedEncode.prompt 写提示词（grounding_px>0 的那个是正向）
  //   - EmptySD3LatentImage 决定输出画幅（保留模板默认）
  const isKrea2 = Object.values(clone).some((n) => /Krea2EditGroundedEncode|Krea2EditModelPatch/i.test(String(n.class_type)))
  if (isKrea2) {
    // 正向节点判定：优先看「谁接了 KSampler.positive」，其次看 grounding_px。
    // 注意 grounding_px 经 UI→API 转换后可能是 undefined（widget 未落到 inputs），
    // 所以不能只靠它判断，否则会把正向提示词写进负向节点。
    const positiveIds = new Set<string>()
    for (const [id, node] of Object.entries(clone)) {
      if (!/^KSampler(Advanced)?$/i.test(String(node.class_type))) continue
      const pos = node.inputs.positive
      if (Array.isArray(pos) && pos.length >= 1) positiveIds.add(String(pos[0]))
    }
    for (const [id, node] of Object.entries(clone)) {
      const ct = String(node.class_type)
      if (/^Krea2EditGroundedEncode$/i.test(ct) && params.positive) {
        const gp = Number(node.inputs.grounding_px ?? NaN)
        const isPositive = positiveIds.has(id) || gp === 0
        if (isPositive) node.inputs.prompt = params.positive
      }
      // 注意：Krea2 是 turbo 模型，负向编码器保持模板原样，不注入资产负词
      if (ct === 'EmptySD3LatentImage') {
        if (params.width && 'width' in node.inputs) node.inputs.width = params.width
        if (params.height && 'height' in node.inputs) node.inputs.height = params.height
      }
    }
  }

  // 图片输出文件名清理：模板前缀常含 %date:yyyyMMddhhmmss%（冒号在 Windows 非法），
  // 会导致写盘失败 + 每次生成同名 → 资产图库永远不增加新版本。
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (!/^(SaveImage|SaveImageAdvanced|PreviewImage)$/i.test(ct)) continue
    const prefix = node.inputs.filename_prefix
    if (typeof prefix === 'string' && /%|[:*?"<>|]/.test(prefix)) {
      node.inputs.filename_prefix = sanitizeOutputName(prefix)
    }
  }

  // ---- 通用（非 H3）路径 ----

  // 千问 Qwen-Image 文本编码器：TextEncodeQwenImage21 / ...Edit / ...EditPlus。
  // 这些节点的 prompt 常是连线到 PrimitiveStringMultiline，必须把值写进那个上游节点，
  // 直接改连线字段会被忽略（实测：不注入就用模板残留提示词，生成与描述无关的图片）。
  let injectedQwen = false
  for (const node of Object.values(clone)) {
    const ct = String(node.class_type)
    if (!/^TextEncodeQwenImage/i.test(ct)) continue
    const promptRef = node.inputs.prompt
    if (Array.isArray(promptRef) && typeof promptRef[0] === 'string' && params.positive !== undefined) {
      const upstream = clone[promptRef[0]]
      if (upstream && /PrimitiveString/i.test(String(upstream.class_type)) && 'value' in upstream.inputs) {
        upstream.inputs.value = params.positive
        injectedQwen = true
      }
    } else if (typeof promptRef === 'string' && params.positive !== undefined) {
      node.inputs.prompt = params.positive
      injectedQwen = true
    }
    if (params.negative !== undefined) {
      const negRef = node.inputs.negative_prompt
      if (Array.isArray(negRef) && typeof negRef[0] === 'string') {
        const up = clone[negRef[0]]
        if (up && /PrimitiveString/i.test(String(up.class_type)) && 'value' in up.inputs) up.inputs.value = params.negative
      } else if (typeof negRef === 'string') {
        node.inputs.negative_prompt = params.negative
      }
    }
  }
  if (!injectedQwen) {
    // 音乐工作流（ACE Step / YuE2）：提示词进 tags / 风格输入，不走 CLIPTextEncode
    const injectedMusic = params.positive ? injectMusicPrompt(clone, params.positive) : false
    if (!injectedMusic) {
      const textNodes = Object.values(clone).filter((n) => String(n.class_type).includes('CLIPTextEncode'))
      if (params.positive !== undefined && textNodes[0]) {
        const t = textNodes[0].inputs
        const key = Object.keys(t).find((k) => /text|prompt/i.test(k)) ?? 'text'
        t[key] = params.positive
      }
      if (params.negative !== undefined && textNodes[1]) {
        const t = textNodes[1].inputs
        const key = Object.keys(t).find((k) => /text|prompt/i.test(k)) ?? 'text'
        t[key] = params.negative
      }
    }
  }

  for (const node of Object.values(clone)) {
    // 兜底守卫：UI 格式的顶层对象（config / extra / seed_widgets）不是节点，
    // 没有 inputs；这里跳过，别让 `'frames' in undefined` 把整次生成打断。
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.inputs !== 'object') continue
    const ct = String(node.class_type).toLowerCase()
    if (ct.includes('emptylatentimage') || ct.includes('latent')) {
      if (params.width && 'width' in node.inputs) node.inputs.width = params.width
      if (params.height && 'height' in node.inputs) node.inputs.height = params.height
      if (params.batch && 'batch_size' in node.inputs) node.inputs.batch_size = params.batch
    }
    if (params.seed !== undefined && 'seed' in node.inputs) {
      node.inputs.seed = params.seed
    }
    if (params.frames && ('frames' in node.inputs || 'length' in node.inputs)) {
      const key = 'frames' in node.inputs ? 'frames' : 'length'
      node.inputs[key] = params.frames
    }
  }
  return clone
}

export function collectTextDefaults(workflow: unknown): { positive: string; negative: string } {
  if (!isWorkflowObject(workflow)) return { positive: '', negative: '' }
  const textNodes = Object.values(workflow)
    .filter((n) => String(n.class_type).includes('CLIPTextEncode'))
    .map((n) => textNodeInputs(n.inputs))
  const positive = textNodes[0] ? String(Object.values(textNodes[0])[0] ?? '') : ''
  const negative = textNodes[1] ? String(Object.values(textNodes[1])[0] ?? '') : ''
  return { positive, negative }
}

/**
 * 从 H3 工作流（API 格式）提取链式续接的工程名和分段 id。
 * 供提交前登记（registerClip）用。非 H3 模板返回 null。
 */
export function extractH3Chain(workflow: unknown): { name: string; shot: string } | null {
  if (!isWorkflowObject(workflow)) return null
  for (const node of Object.values(workflow)) {
    if (String(node.class_type) !== 'CSGlideCastCS') continue
    const field = h3DataField(node)
    if (!field) continue
    const h3 = tryParse<{ chain?: { name?: string; shot?: string } }>(node.inputs[field])
    const name = h3?.chain?.name?.trim()
    if (!name) continue
    return { name, shot: h3?.chain?.shot?.trim() ?? '' }
  }
  return null
}
