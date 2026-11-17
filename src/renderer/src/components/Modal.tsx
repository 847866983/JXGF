import type { ReactNode } from 'react'
import { X } from 'lucide-react'

const SIZE_CLASS: Record<'md' | 'lg' | 'xl' | 'wide', string> = {
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
  wide: 'max-w-[1400px]'
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md'
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 弹窗宽度档位，默认 md */
  size?: 'md' | 'lg' | 'xl' | 'wide'
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        className={`panel flex max-h-[92vh] w-full ${SIZE_CLASS[size]} flex-col overflow-hidden`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="text-sm font-semibold text-white">{title}</div>
          <button className="text-slate-400 transition-colors hover:text-white" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-white/5 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  )
}
