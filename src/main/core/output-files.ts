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
