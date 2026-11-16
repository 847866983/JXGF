import { useApp } from '../store/app'
import type { Project } from '@shared/types'

/**
 * 统一的项目写入口：
 * 以主进程当前项目为 base（而非渲染层可能滞后的快照），
 * 结构化克隆 → mutate 修改副本 → 保存。
 * 这样生成完成时主进程写回的 shot.outputs / asset.images 不会被旧快照覆盖。
 */
export async function persistProject(mutate: (draft: Project) => void): Promise<void> {
  const latest = await window.api.projectGetCurrent()
  if (!latest) return
  const next = structuredClone(latest)
  mutate(next)
  next.updatedAt = new Date().toISOString()
  await useApp.getState().saveProject(next)
}
