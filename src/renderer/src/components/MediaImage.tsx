import { useEffect, useState, type ReactNode } from 'react'
import { useMediaSrc } from '../lib/mediaSrc'

/** 统一的媒体预览：本地路径自动转 data URL，失败或无源时显示 fallback */
export function MediaImage({
  src,
  alt,
  className,
  fallback
}: {
  src: string | null | undefined
  alt?: string
  className?: string
  fallback: ReactNode
}): React.JSX.Element {
  const disp = useMediaSrc(src)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!disp || failed) return <>{fallback}</>
  return <img src={disp} alt={alt} className={className} onError={() => setFailed(true)} />
}
