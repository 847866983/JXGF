import { useNavigate } from 'react-router-dom'
import { FolderOpen } from 'lucide-react'
import { useApp } from '../store/app'
import { EmptyState } from './ui'

/**
 * 未打开项目时的统一空态：优先「打开最近项目」，否则去仪表盘选择。
 */
export function NoProject(props: { title?: string; desc?: string }): React.JSX.Element {
  const navigate = useNavigate()
  const openProject = useApp((s) => s.openProject)

  const openLast = async (): Promise<void> => {
    const last = localStorage.getItem('jxgf:lastProject')
    if (last) {
      try {
        await openProject(last)
        return
      } catch {
        // 最近项目已不存在，退回仪表盘
      }
    }
    navigate('/dashboard')
  }

  return (
    <EmptyState
      icon={<FolderOpen size={22} />}
      title={props.title ?? '还没有打开项目'}
      desc={props.desc ?? '打开最近的项目，或去仪表盘选择 / 新建一个项目'}
      action={
        <button className="btn-primary" onClick={() => void openLast()}>
          <FolderOpen size={15} />
          打开最近项目
        </button>
      }
    />
  )
}
