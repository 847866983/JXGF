import { useApp } from '../store/app'
import type { Project } from '@shared/types'

/**
 * 统一的项目写入口：
 * 从 store 取最新 project → 结构化克隆 → 交给 mutate 修改副本 → 保存。
 * 调用方绝不在 mutate 之外修改 store 里的引用。
 */
export async function persistProject(mutate: (draft: Project) => void): Promise<void> {
  const current = useApp.getState().project
  if (!current) return
  const next = structuredClone(current)
  mutate(next)
  next.updatedAt = new Date().toISOString()
  await useApp.getState().saveProject(next)
}
