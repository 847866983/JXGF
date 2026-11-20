/** ComfyUI 产物提取：WS executed 与 history.outputs 两种来源统一收集媒体文件 */

export interface MediaFile {
  filename: string
  subfolder: string
  type: string
  /** BanZhang painter_output 里的本地绝对路径（可选，优先直接读取） */
  src_path?: string
  /** 附加元数据（fps/frame_count/width/height/duration/kind） */
  metadata?: Record<string, unknown>
}

/**
 * 从单个节点的 output 里收集媒体文件。
 * 支持标准 images/videos/gifs，以及 BanZhang 节点的 painter_output（H3 三采/一采/二采）。
 */
export function collectMediaFiles(output: unknown): MediaFile[] {
  if (!output || typeof output !== 'object') return []
  const o = output as Record<string, unknown>
  const files: MediaFile[] = []
  const pushArr = (v: unknown): void => {
    if (!Array.isArray(v)) return
    for (const f of v) {
      if (f && typeof f === 'object' && typeof (f as MediaFile).filename === 'string') {
        files.push(f as MediaFile)
      }
    }
  }
  for (const key of ['videos', 'images', 'gifs', 'painter_output']) {
    pushArr(o[key])
  }
  return files
}

/** 从 history 条目的 outputs（多节点）里收集所有媒体文件 */
export function collectHistoryFiles(outputs: unknown): MediaFile[] {
  if (!outputs || typeof outputs !== 'object') return []
  const files: MediaFile[] = []
  for (const node of Object.values(outputs as Record<string, unknown>)) {
    files.push(...collectMediaFiles(node))
  }
  return files
}

/** 按 .NET 风格格式串（yyyyMMddHHmmss 等）格式化时间 */
function formatStamp(fmt: string, d = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, p2(d.getMonth() + 1))
    .replace(/dd/g, p2(d.getDate()))
    .replace(/HH/g, p2(d.getHours()))
    .replace(/hh/g, p2(d.getHours()))
    .replace(/mm/g, p2(d.getMinutes()))
    .replace(/ss/g, p2(d.getSeconds()))
    .replace(/fff/g, String(d.getMilliseconds()).padStart(3, '0'))
}

/**
 * 规范化产出文件名，避免 Windows 非法字符导致写盘失败。
 *
 * 关键问题：BanZhang/千问模板的 SaveImage 前缀常带 `%date:yyyyMMddhhmmss%`，
 * 其中的冒号在 Windows 上是非法文件名字符 —— ComfyUI 展开后写盘失败（只留 0 字节文件），
 * 且每次生成的"文件名"完全相同，资产图库去重后永远不增加新版本，
 * 表现为「点了生成没反应」。
 */
export function sanitizeOutputName(name: string, d = new Date()): string {
  let n = String(name ?? '')
  // 展开 ComfyUI 的日期/时间占位符（它们的格式串里带冒号）
  n = n.replace(/%date:([^%]*)%/gi, (_m, f: string) => formatStamp(f || 'yyyyMMddHHmmss', d))
  n = n.replace(/%time:([^%]*)%/gi, (_m, f: string) => formatStamp(f || 'HHmmss', d))
  // 其它未知占位符直接去掉，避免残留非法字符
  n = n.replace(/%[A-Za-z_]+:[^%]*%/g, '')
  // Windows 非法字符 -> 下划线
  n = n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  n = n.replace(/\s+/g, ' ').trim()
  n = n.replace(/^\.+/, '')
  return n || 'output'
}

/** 规范化完整相对路径（逐段处理，保留 / 分隔与子目录） */
export function sanitizeOutputPath(relPath: string, d = new Date()): string {
  const parts = String(relPath ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((seg) => sanitizeOutputName(seg, d))
  return parts.join('/')
}

/**
 * 从多个产物里挑「最终清晰版」。
 * H3 三采工作流依次产出 一采/二采/三采，必须选三采；
 * 找不到三采时退回最后一个（通常是最终节点）。
 */
export interface StagePick {
  first: boolean
  second: boolean
  third: boolean
  superRes: boolean
}

/**
 * 从多个产物里挑出用户选择的那一阶段。
 *
 * H3 三采工作流会依次产出 一采 → 二采 → 三采（三个独立输出节点）。
 * 用户只勾一采时，就只要一采那一条，不要后面的放大/重绘版本。
 */
export function pickFinalMedia(
  files: MediaFile[],
  kind: 'image' | 'video',
  stages?: StagePick
): MediaFile[] {
  const all = files.filter((f) => f && typeof f.filename === 'string')
  if (all.length === 0) return []
  if (kind !== 'video') return all.slice(-1)

  const s = stages ?? { first: true, second: true, third: true, superRes: false }
  const RE = {
    first: /一采|_N467|first_?pass/i,
    second: /二采|second_?pass/i,
    third: /三采|final|_N471|3rd/i
  }
  const order: ('third' | 'second' | 'first')[] = ['third', 'second', 'first']
  for (const key of order) {
    if (!s[key]) continue
    const hit = all.filter((f) => RE[key].test(f.filename))
    if (hit.length > 0) return hit
  }
  // 一个都没匹配上（老工作流/改名）：退回最后一个
  return all.slice(-1)
}
