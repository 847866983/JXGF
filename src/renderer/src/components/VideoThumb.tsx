import { useEffect, useRef, useState } from 'react'

/** 本地视频预览：经主进程 IPC 读成 data URL 播放（可靠，避开 appmedia 对 mp4 Range 的兼容问题） */
export function VideoThumb({
  src,
  className
}: {
  src: string | null | undefined
  className?: string
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    let alive = true
    if (!src) {
      setUrl(null)
      return
    }
    setUrl(null)
    window.api
      .mediaDataUrl(src)
      .then((d) => {
        if (alive) setUrl(d)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [src])
  if (!url) {
    return <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">加载视频…</div>
  }
  return (
    <video
      ref={ref}
      src={url}
      className={className}
      controls
      playsInline
      preload="auto"
      onLoadedData={(e) => {
        // 跳到 1 秒处显示有效画面（首帧可能是黑场）
        const v = e.currentTarget
        if (Number.isFinite(v.duration) && v.duration > 1.2) v.currentTime = 1
      }}
    />
  )
}
