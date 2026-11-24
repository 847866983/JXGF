import { useEffect, useState } from 'react'

/** 本地图片/视频预览：本地路径经主进程 IPC 读成 data URL（避开 file:// 安全限制与自定义协议坑） */

function toLocalPath(src: string): string {
  if (/^file:/i.test(src)) {
    try {
      let p = decodeURIComponent(new URL(src).pathname)
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
      return p
    } catch {
      return src
    }
  }
  return src
}

/** 把任意图片来源解析成 <img>/<video> 可用的 src；本地文件通过 IPC 读成 data URL */
export function useMediaSrc(src: string | null | undefined): string | null {
  const [out, setOut] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!src) {
      setOut(null)
      return
    }
    if (/^(https?:|data:)/i.test(src)) {
      setOut(src)
      return
    }
    const local = toLocalPath(src)
    window.api
      .mediaDataUrl(local)
      .then((d) => {
        if (alive) setOut(d)
      })
      .catch(() => {
        if (alive) setOut(null)
      })
    return () => {
      alive = false
    }
  }, [src])
  return out
}
