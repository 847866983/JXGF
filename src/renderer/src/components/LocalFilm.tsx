import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, Clapperboard, Film, History, Link2, Maximize2, MoreHorizontal,
  Pause, Play, Plus, RefreshCw, Scissors, Send, SkipBack, SkipForward, Upload, X, ZoomIn, ZoomOut
} from 'lucide-react'
import { EmptyState } from './ui'

/**
 * 本地整片预览 + 时间轴（对齐节点包网页端「全片总览」）。
 *
 * 数据源完全来自工程里每段「已生成的成片」（shot.outputs），不依赖 ComfyUI 档案。
 * - 上方取景器：把已生成的段按顺序连续播放（一段放完自动接下一段），即「自动拼接」的观看效果。
 * - 下方时间轴：所有段按帧长首尾相接铺成一条，带刻度 / 缩略图 / 波形 / 播放头，点段块跳转。
 * - 工具栏：接一段 / 裁切 / 全部渲染 / 导出成片 / 推送整片 / 历史 / 工程。
 * - 段工具：保留头尾帧 / 取消接续。
 * 两段共享同一个播放帧，所以播放头与时间码始终同步。
 */

export interface LocalClip {
  shotId: string
  /** 段号（1-based） */
  index: number
  /** 已生成成片路径；null = 该段尚未生成 */
  file: string | null
  kind: 'video' | 'image'
  frames: number
  durationSec: number
  contMode: string
  pinHead: number
  pinTail: number
  /** 该段已生成的版本列表（含被弃用的旧版），用于就地切换 */
  takes: LocalTake[]
}

export interface LocalTake {
  id: string
  label: string
  file: string
  kept: boolean
}

interface Props {
  clips: LocalClip[]
  fps: number
  activeShotId?: string
  onSelectShot?: (shotId: string) => void
  onAppendShot?: () => void
  onExportFilm?: (file: string, name: string) => void
  onPushWhole?: () => void
  onOpenHistory?: () => void
  onOpenProjects?: () => void
  onTrim?: () => void
  onPatchPin?: (shotId: string, field: 'pinHead' | 'pinTail', value: number) => void
  onCancelContinue?: (shotId: string) => void
  onRegenShot?: (shotId: string) => void
  onContinueToNext?: (shotId: string) => void
  onKeepTake?: (shotId: string, takeId: string) => void
  /** 删除某个已生成的产物版本（至少保留一个） */
  onDeleteTake?: (shotId: string, takeId: string) => void
  /** 请求无缝整片 data URL（多段导成一个视频，播放零卡顿）；返回 null 则退回分段播放 */
  onRequestWholeFilm?: () => Promise<string | null>
  viewerClassName?: string
  render: (parts: {
    viewer: React.ReactNode
    timeline: React.ReactNode
    meta: React.ReactNode
  }) => React.ReactNode
}

function fmt(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}

function ClipThumb({ url }: { url?: string }): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  if (!url) return <div className="h-full w-full bg-white/[0.04]" />
  return (
    <video
      ref={ref}
      src={url}
      muted
      preload="metadata"
      className="h-full w-full object-cover"
      onLoadedData={() => {
        if (ref.current && Number.isFinite(ref.current.duration)) {
          try {
            ref.current.currentTime = Math.min(0.5, Math.max(0, ref.current.duration - 0.05))
          } catch {
            /* 元数据未就绪 */
          }
        }
      }}
    />
  )
}

/** 小数字输入框（失焦/回车提交） */
function MiniNum({
  value, onCommit, title
}: {
  value: number
  onCommit: (n: number) => void
  title?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n) && n >= 0) onCommit(Math.round(n))
    else setDraft(String(value))
  }
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      title={title}
      className="h-5 w-10 rounded border border-white/10 bg-ink-950/70 px-1 text-center text-[11px] text-slate-200 outline-none focus:border-accent/60"
    />
  )
}

export default function LocalFilm({
  clips,
  fps,
  activeShotId,
  onSelectShot,
  onAppendShot,
  onExportFilm,
  onPushWhole,
  onOpenHistory,
  onOpenProjects,
  onTrim,
  onPatchPin,
  onCancelContinue,
  onRegenShot,
  onContinueToNext,
  onKeepTake,
  onDeleteTake,
  onRequestWholeFilm,
  viewerClassName = 'h-[300px]',
  render
}: Props): React.JSX.Element {
  const fpsSafe = fps > 0 ? fps : 24
  const totalFrames = useMemo(() => clips.reduce((a, c) => a + c.frames, 0), [clips])
  const totalSec = totalFrames / fpsSafe

  // 每段在时间轴里的起始帧（累计）
  const starts = useMemo(() => {
    const map: Record<string, number> = {}
    let acc = 0
    for (const c of clips) {
      map[c.shotId] = acc
      acc += c.frames
    }
    return map
  }, [clips])

  const [urls, setUrls] = useState<Record<string, string>>({})
  const [idx, setIdx] = useState(() => {
    const first = clips.findIndex((c) => c.file)
    return first >= 0 ? first : 0
  })
  const [curTime, setCurTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pxPerFrame, setPxPerFrame] = useState(0)
  const [wave, setWave] = useState<number[]>([])
  const [showTrim, setShowTrim] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [marks, setMarks] = useState<number[]>([])
  /** 段块上展开的版本选择菜单（存 shotId），null=无 */
  const [openTakeMenu, setOpenTakeMenu] = useState<string | null>(null)
  /** 版本菜单里各产物的实际时长（懒加载 metadata）；与段设定不一致时标 ⚠ 提示重抽 */
  const [takeDurations, setTakeDurations] = useState<Record<string, number>>({})

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef(false)
  /** 拖动 scrub 中（渲染期可用）：拖动时播放头要禁用 left 过渡，避免跟手延迟 */
  const [dragging, setDragging] = useState(false)
  /** 连续播放意图：切段后新视频加载完成时要不要自动播 */
  const wantPlayRef = useRef(false)
  /** 手动 seek 的段内目标时间；新视频加载后定位到这里 */
  const seekTargetRef = useRef<number | null>(null)
  /** 当前正在播放的段索引；防止同一段 onEnded 被重复处理 */
  const playingIdxRef = useRef<number>(-1)
  /** 播放会话锁定的 src（hooks 顶部声明，供各提前 return 前的 effect 使用） */
  const [lockedUrl, setLockedUrl] = useState<string | undefined>(undefined)
  /** 版本时长与段设置不一致的提示（旧参数产物） */
  const [durationHint, setDurationHint] = useState<string | null>(null)
  /** 无缝整片 data URL：连续播放整片时用它播放单个视频，消除段间卡顿 */
  const [wholeUrl, setWholeUrl] = useState<string | null>(null)
  const wholeVideoRef = useRef<HTMLVideoElement | null>(null)
  /** 整片播放中（区别于分段播放） */
  const [wholePlaying, setWholePlaying] = useState(false)
  /** 正在后台拼接整片（远程导出可能要几秒），期间播放按钮显示等待 */
  const [wholeLoading, setWholeLoading] = useState(false)

  const clipsKey = clips.map((c) => `${c.shotId}:${c.file ?? ''}`).join('|')

  /* 预加载所有已生成段的 data URL（本地读取，切段不卡） */
  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Record<string, string> = {}
      for (const c of clips) {
        if (!c.file) continue
        const u = await window.api.mediaDataUrl(c.file).catch(() => null)
        if (u) out[c.shotId] = u
      }
      if (alive) setUrls(out)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsKey])

  /* 波形：对当前段成片取音频包络（ComfyUI join/waveform 支持本地绝对路径） */
  useEffect(() => {
    const file = clips[idx]?.file
    if (!file) {
      setWave([])
      return
    }
    let alive = true
    void (async () => {
      const r = await window.api.cglideJoinWaveform(file, 1200).catch(() => null)
      if (alive) setWave(Array.isArray(r?.bins) ? r.bins! : [])
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips[idx]?.file])

  /* 当前段若指向未生成，跳到第一段已生成的 */
  useEffect(() => {
    if (!clips[idx]?.file) {
      const first = clips.findIndex((c) => c.file)
      if (first >= 0) {
        setLockedUrl(urls[clips[first].shotId])
        setIdx(first)
      }
    }
  }, [clips, idx])

  /* 选中段变化 → 大窗口切到该段。
     若这次变化来自"点段块精确定位"，seekFrame 已设好目标帧，这里就不覆盖成段首。
     生成后自动选中 / 重抽等没有定位意图的场景，仍回段首暂停。 */
  const lastActiveRef = useRef<string | undefined>(activeShotId)
  const seekingByClickRef = useRef(false)
  useEffect(() => {
    if (!activeShotId || activeShotId === lastActiveRef.current) return
    lastActiveRef.current = activeShotId
    const i = clips.findIndex((c) => c.shotId === activeShotId)
    if (i < 0) return
    if (seekingByClickRef.current) {
      // 段块点击已处理定位/切段，这里只同步索引，不重置 seekTarget/curTime
      seekingByClickRef.current = false
      setIdx(i)
      return
    }
    wantPlayRef.current = false
    videoRef.current?.pause()
    seekTargetRef.current = 0
    setLockedUrl(undefined) // 手动选段：解锁到该段当前 kept 版本
    setIdx(i)
    setCurTime(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShotId, clips])

  /* 版本菜单打开时：懒加载该段各版本的实际时长（metadata），供「旧参数」标记 */
  useEffect(() => {
    if (!openTakeMenu) return
    const target = clips.find((c) => c.shotId === openTakeMenu)
    if (!target) return
    let alive = true
    void (async () => {
      for (const t of target.takes) {
        if (!alive) return
        if (takeDurations[t.id] !== undefined) continue
        const du = await window.api.mediaDataUrl(t.file).catch(() => null)
        if (!du || !alive) continue
        const dur = await new Promise<number | null>((resolve) => {
          const v = document.createElement('video')
          v.preload = 'metadata'
          v.onloadedmetadata = () => {
            resolve(Number.isFinite(v.duration) ? v.duration : null)
            v.removeAttribute('src')
          }
          v.onerror = () => resolve(null)
          v.src = du
        })
        if (dur !== null && alive) setTakeDurations((p) => ({ ...p, [t.id]: dur }))
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTakeMenu])

  const clip = clips[idx]
  const url = clip ? urls[clip.shotId] : undefined
  // 播放会话中用锁定的 src；未播放时跟随最新 kept 版本
  const activeUrl = lockedUrl ?? url
  // 下一段的 url：后台预挂载隐藏 video 提前解码，消除切段时的加载/解码卡顿
  const nextIdx = (() => {
    let n = idx + 1
    while (n < clips.length && !clips[n].file) n += 1
    return n < clips.length ? n : -1
  })()
  const preloadUrl = nextIdx >= 0 ? urls[clips[nextIdx]?.shotId] : undefined
  // 整片模式下 curTime 就是全片时间，不能再叠加当前段的起始帧
  const globalFrame = Math.min(
    totalFrames,
    (wholeUrl ? 0 : clip ? starts[clip.shotId] ?? 0 : 0) + curTime * fpsSafe
  )

  const playAt = (i: number): void => {
    // 主动切段 → 退出整片无缝模式，回到分段
    if (wholeUrl) { wholeVideoRef.current?.pause(); setWholeUrl(null); setWholePlaying(false) }
    wantPlayRef.current = true
    seekTargetRef.current = null
    playingIdxRef.current = i
    setLockedUrl(urls[clips[i]?.shotId])
    setIdx(i)
    setCurTime(0)
    setPlaying(true)
  }

  const toggle = (): void => {
    // 整片播放模式：用拼好的单视频，无段间卡顿
    if (wholeUrl) {
      const wv = wholeVideoRef.current
      if (!wv) return
      if (wv.paused) void wv.play().catch(() => undefined)
      else wv.pause()
      return
    }
    // 从第一段开始连续播放 + 有多段 → 尝试无缝整片（导出拼成一个视频）
    if (idx === 0 && clips.length > 1 && onRequestWholeFilm && !playing) {
      setWholeLoading(true)
      // 拼接失败/抛异常都退回原来的分段播放，不让播放按钮「点了没反应」
      const fallback = (): void => {
        const v = videoRef.current
        if (!v) return
        wantPlayRef.current = true
        playingIdxRef.current = idx
        setLockedUrl(url)
        void v.play().catch(() => undefined)
      }
      void onRequestWholeFilm().then((wu) => {
        if (wu) {
          setWholeUrl(wu)
          setWholePlaying(true)
          // 下一 tick video 挂载后自动播放
          setTimeout(() => { void wholeVideoRef.current?.play().catch(() => undefined) }, 50)
        } else {
          fallback()
        }
      }).catch(fallback).finally(() => setWholeLoading(false))
      return
    }
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      wantPlayRef.current = true
      playingIdxRef.current = idx
      // 开始播放：锁定当前段的 src（播放期间后台产物更新不再影响本会话）
      setLockedUrl(url)
      void v.play().catch(() => undefined)
    } else {
      wantPlayRef.current = false
      playingIdxRef.current = -1
      v.pause()
    }
  }

  /** 退出整片播放，回到分段模式首帧 */
  const exitWholeFilm = (): void => {
    wholeVideoRef.current?.pause()
    setWholeUrl(null)
    setWholePlaying(false)
    setWholeLoading(false)
    setCurTime(0)
    setLockedUrl(undefined)
  }

  /* 新视频元数据就绪：应用手动 seek 目标；若处于连续播放意图则真正开播 */
  const onLoadedData = (e: React.SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget
    // 版本时长 vs 段设置时长：不一致说明该版本是旧参数的产物（比如改过段时长后没重抽）
    const clipNow = clips[idx]
    if (clipNow?.durationSec && Number.isFinite(v.duration) && v.duration > 0.5) {
      const diff = Math.abs(v.duration - clipNow.durationSec)
      setDurationHint(
        diff > 0.6
          ? `此版本时长 ${v.duration.toFixed(1)}s 与当前段设置 ${clipNow.durationSec.toFixed(1)}s 不一致（旧参数产物，改过段时长后未重抽）——建议「重抽本段」`
          : null
      )
    } else {
      setDurationHint(null)
    }
    const target = seekTargetRef.current
    if (target !== null) {
      seekTargetRef.current = null
      try {
        v.currentTime = Math.max(0, Math.min(target, v.duration || target))
      } catch {
        /* 忽略 */
      }
    } else if (!wantPlayRef.current && Number.isFinite(v.duration) && v.duration > 0.5) {
      try {
        v.currentTime = 0.4
      } catch {
        /* 忽略 */
      }
    }
    // 只有在"连续播放会话中、且当前视频未结束"时才自动开播，避免播完后因重渲染又播一遍
    if (wantPlayRef.current && !v.ended && v.paused) void v.play().catch(() => undefined)
  }

  /* 一段播完自动接下一段（跳过未生成的），实现整片连续播放 */
  const onEnded = (): void => {
    // 同一段可能触发多次 ended（src 重设/seek 后）；只处理当前正在播放的那一段一次
    if (playingIdxRef.current !== idx) return
    let n = idx + 1
    while (n < clips.length && !clips[n].file) n += 1
    if (n < clips.length) {
      playAt(n)
    } else {
      // 整片播放结束：彻底清掉播放意图并暂停，任何后续重渲染都不再自动开播
      wantPlayRef.current = false
      playingIdxRef.current = -1
      setPlaying(false)
      setLockedUrl(undefined) // 解锁：回到该段当前的 kept 版本首帧
      videoRef.current?.pause()
    }
  }

  /* 时间轴点击 / 拖动：把全局帧换算成 (段, 段内时间)。
     play=true 时定位到该帧并立即播放（"从这一帧开始看"）；play=false 只定位暂停（拖动 scrub）。 */
  const seekFrame = (f: number, play = false): void => {
    // 整片模式下点时间轴 → 退出整片，回到分段定位
    if (wholeUrl) { wholeVideoRef.current?.pause(); setWholeUrl(null); setWholePlaying(false) }
    const clamped = Math.max(0, Math.min(totalFrames, f))
    let acc = 0
    for (let i = 0; i < clips.length; i += 1) {
      const end = acc + clips[i].frames
      if (clamped < end || i === clips.length - 1) {
        if (clips[i].file && urls[clips[i].shotId]) {
          const t = (clamped - acc) / fpsSafe
          wantPlayRef.current = play
          seekTargetRef.current = t
          playingIdxRef.current = play ? i : -1
          // 主动定位/切段：锁定到目标段当前版本（用户意图优先于后台产物更新）
          setLockedUrl(urls[clips[i].shotId])
          setIdx(i)
          setCurTime(t)
          const v = videoRef.current
          if (v && clips[i].shotId === clip?.shotId) {
            // 同一段：直接写 currentTime，立即定位（不必等视频重载）
            try {
              v.currentTime = Math.max(0, Math.min(t, v.duration || t))
              if (play) void v.play().catch(() => undefined)
            } catch {
              /* 元数据未就绪 */
            }
          }
          // 跨段：setIdx 触发 video 重挂载，onLoadedData 消费 seekTargetRef 定位，
          // 若 wantPlayRef=true 则自动开播（见 onLoadedData）
        }
        return
      }
      acc = end
    }
  }

  const frameAtClientX = (clientX: number): number => {
    const band = bandRef.current
    const track = trackRef.current
    if (!band || !track || pxPerFrame <= 0) return 0
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(totalFrames, (clientX - rect.left) / pxPerFrame))
  }

  /** 时间轴按下时是否发生了拖动（区分"点一下定位+播放"与"拖动 scrub 暂停"） */
  const draggedRef = useRef(false)
  const downFrameRef = useRef(0)
  const onBandDown = (e: React.MouseEvent): void => {
    dragRef.current = true
    setDragging(true)
    draggedRef.current = false
    downFrameRef.current = Math.round(frameAtClientX(e.clientX))
    seekFrame(downFrameRef.current, false) // 按下先定位并暂停，拖动时持续 scrub
  }
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (dragRef.current) {
        draggedRef.current = true
        seekFrame(Math.round(frameAtClientX(e.clientX)), false)
      }
    }
    const up = (): void => {
      if (!dragRef.current) return
      dragRef.current = false
      setDragging(false)
      // 纯点击（没拖动）→ 从按下那一帧开始播放
      if (!draggedRef.current) seekFrame(downFrameRef.current, true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerFrame, totalFrames, urls])

  /* 适配宽度 */
  const fit = (): void => {
    const vw = bandRef.current?.clientWidth ?? 0
    if (vw < 60 || totalFrames < 2) return
    setPxPerFrame(vw / totalFrames)
  }
  useEffect(() => {
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalFrames])
  useEffect(() => {
    const el = bandRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const contentW = Math.max(1, pxPerFrame * totalFrames)

  const zoom = (factor: number): void => {
    setPxPerFrame((p) => {
      const vw = bandRef.current?.clientWidth ?? 600
      const min = totalFrames > 0 ? vw / totalFrames : 1
      return Math.max(min, Math.min(8, (p || min) * factor))
    })
  }

  /* 波形绘制（绿色，对齐参考图） */
  useEffect(() => {
    const cv = waveRef.current
    if (!cv) return
    const w = Math.max(1, Math.round(contentW))
    const h = 30
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.round(h * dpr)
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (wave.length === 0) return
    ctx.fillStyle = 'rgba(34, 197, 94, 0.75)'
    const mid = h / 2
    const step = w / wave.length
    for (let i = 0; i < wave.length; i += 1) {
      const v = Math.max(0, Math.min(1, Number(wave[i]) || 0))
      const bh = Math.max(1, v * (h - 3))
      ctx.fillRect(i * step, mid - bh / 2, Math.max(step * 0.75, 0.6), bh)
    }
  }, [wave, contentW])

  const ticks = useMemo(() => {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
    const step = steps.find((s) => totalSec / s <= 8) ?? 300
    const out: { x: number; label: string }[] = []
    for (let s = 0; s <= totalSec + 0.001; s += step) {
      out.push({ x: s * fpsSafe * pxPerFrame, label: fmt(s) })
    }
    return out
  }, [totalSec, fpsSafe, pxPerFrame])

  const generatedCount = clips.filter((c) => c.file).length
  const curFrameInSeg = Math.round(curTime * fpsSafe)
  const activeClip = clips.find((c) => c.shotId === activeShotId) ?? clip

  /* 工具栏按钮：统一视觉 */
  const toolBtn = (
    label: string,
    icon: React.ReactNode,
    onClick: (() => void) | undefined,
    opts: { primary?: boolean; active?: boolean; disabled?: boolean; title?: string } = {}
  ): React.JSX.Element => (
    <button
      className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
        opts.primary || opts.active
          ? 'border-accent-500/60 bg-accent-600/15 text-accent-200 hover:bg-accent-600/25'
          : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/25 hover:text-slate-200'
      }`}
      disabled={opts.disabled || !onClick}
      onClick={onClick}
      title={opts.title ?? label}
    >
      {icon}{label}
    </button>
  )

  const viewer = (
    <div className={`relative shrink-0 overflow-hidden rounded-lg bg-black ${viewerClassName}`}>
      {durationHint && !wholeUrl && (
        <div className="absolute left-2 top-2 z-10 max-w-[85%] rounded bg-amber-500/90 px-2 py-1 text-[11px] leading-snug text-black shadow">
          {durationHint}
        </div>
      )}
      {wholeUrl && (
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded bg-black/65 px-2 py-1 text-[11px] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          无缝整片
          <button
            className="ml-1 rounded border border-white/15 px-1 text-[10px] text-slate-300 hover:text-white"
            onClick={exitWholeFilm}
            title="退出整片，回到分段预览"
          >
            退出
          </button>
        </div>
      )}
      {wholeUrl ? (
        <video
          ref={wholeVideoRef}
          src={wholeUrl}
          className="h-full w-full object-contain"
          playsInline
          preload="auto"
          onTimeUpdate={(e) => {
            // 整片时间即全局时间：curTime 直接喂全局帧，时间轴/播放头才跟着走
            setCurTime(e.currentTarget.currentTime)
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setWholePlaying(false)
            // 播完回到分段模式首帧：清掉整片时间，播放头/时间码归零
            setWholeUrl(null)
            setCurTime(0)
            setIdx(0)
            setLockedUrl(undefined)
          }}
          onClick={toggle}
        />
      ) : clip?.file && clip.kind === 'video' ? (
        url ? (
          <video
            key={clip.shotId}
            ref={videoRef}
            src={activeUrl}
            className="h-full w-full object-contain"
            playsInline
            preload="auto"
            onLoadedData={onLoadedData}
            onTimeUpdate={(e) => setCurTime(e.currentTarget.currentTime)}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={toggle}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">加载成片…</div>
        )
      ) : clip?.file && clip.kind === 'image' ? (
        <img src={clip.file} className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full items-center justify-center px-4">
          <EmptyState
            compact
            icon={<Film size={16} />}
            title="这一段还没有成片"
            desc="先生成任意一段，整片预览就会出现在这里"
          />
        </div>
      )}
      {/* 下一段预热：隐藏 video 提前加载+解码首帧，切段时无加载卡顿 */}
      {preloadUrl && preloadUrl !== activeUrl && (
        <video
          src={preloadUrl}
          muted
          playsInline
          preload="auto"
          className="pointer-events-none absolute left-0 top-0 h-1 w-1 opacity-0"
          onLoadedData={(e) => {
            const v = e.currentTarget
            // seek 到极靠前的一帧，强制解码器预热（仅 seek 不播放，不占音频/画面）
            if (Number.isFinite(v.duration) && v.duration > 0.1) {
              try { v.currentTime = 0.04 } catch { /* 忽略 */ }
            }
          }}
        />
      )}
      {clip?.file && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1">
          <button
            className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
            onClick={() => seekFrame(Math.max(0, (starts[clip.shotId] ?? 0) - 0.01))}
            title="上一段"
          >
            <SkipBack size={13} />
          </button>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-60"
            onClick={toggle}
            disabled={wholeLoading}
            title={wholeLoading ? '正在拼接近无缝整片…' : playing ? '暂停' : '连续播放整片'}
          >
            {wholeLoading ? <RefreshCw size={14} className="animate-spin" /> : playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80"
            onClick={() => {
              const i = clips.findIndex((c) => c.shotId === clip.shotId)
              if (i >= 0) playAt(i + 1 < clips.length ? i + 1 : 0)
            }}
            title="下一段"
          >
            <SkipForward size={13} />
          </button>
        </div>
      )}
      <div className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-[11px] text-slate-200">
        第 {clip?.index ?? 0} 段 / 共 {generatedCount} 段 · {fmt(globalFrame / fpsSafe)} / {fmt(totalSec)}
      </div>
    </div>
  )

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 px-3 py-2">
      <Clapperboard size={13} className="text-accent-400" />
      <span className="mr-1 text-[11px] font-medium text-slate-200">全片总览</span>
      <span className="mr-2 text-[11px] text-slate-600">{clips.length} 段</span>
      {toolBtn('接一段', <Plus size={11} />, onAppendShot, { title: '在时间轴末尾追加一段新分镜' })}
      {toolBtn('裁切', <Scissors size={11} />, () => setShowTrim((v) => !v), {
        title: '裁切：调整当前段保留的头/尾帧'
      })}
      {toolBtn('导出成片', <Upload size={11} />, () => {
        if (clip?.file) onExportFilm?.(clip.file, `第${clip.index}段`)
      }, { disabled: !clip?.file, title: '把当前段成片另存到本地' })}
      {toolBtn('推送整片', <Send size={11} />, onPushWhole, { title: '把拼接后的整片登记为后续段的视频参考' })}
      {toolBtn('历史', <History size={11} />, () => setShowHistory((v) => !v), {
        disabled: (activeClip?.takes.length ?? 0) === 0,
        active: showHistory || (activeClip?.takes.length ?? 0) > 1,
        title: (activeClip?.takes.length ?? 0) > 1 ? `本段有 ${activeClip?.takes.length} 个版本，点击查看/切换` : '查看/切换当前段的产物版本'
      })}
      <div className="relative ml-auto">
        <button
          className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
          onClick={() => setShowProjects((v) => !v)}
        >
          工程 <ChevronDown size={11} />
        </button>
        {showProjects && (
          <div className="absolute right-0 top-full z-30 mt-1 w-32 rounded border border-white/10 bg-ink-900 p-1 shadow-xl">
            <button
              className="w-full rounded px-2 py-1.5 text-left text-[11px] text-slate-300 hover:bg-white/5"
              onClick={() => {
                setShowProjects(false)
                onOpenProjects?.()
              }}
            >
              工程列表
            </button>
          </div>
        )}
      </div>
    </div>
  )

  /* 下一段（续接目标）：当前段在 clips 里的后一段 */
  const activeIdx = activeClip ? clips.findIndex((c) => c.shotId === activeClip.shotId) : -1
  const nextClip = activeIdx >= 0 && activeIdx < clips.length - 1 ? clips[activeIdx + 1] : null

  /* 段工具行：第 N 段 / 保留头尾 / 重抽 / 续接下一段 / 取消接续 */
  const segToolRow = (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-white/[0.015] px-3 py-1.5">
      <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-200">
        第 {activeClip?.index ?? 0} 段
      </span>
      <span className="text-[11px] text-slate-500">保留</span>
      <MiniNum
        value={activeClip?.pinHead ?? 0}
        title="保留头帧"
        onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinHead', n)}
      />
      <span className="text-[11px] text-slate-500">头</span>
      <MiniNum
        value={activeClip?.pinTail ?? 0}
        title="保留尾帧"
        onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinTail', n)}
      />
      <span className="text-[11px] text-slate-500">尾</span>
      {activeClip && (
        <button
          className="flex items-center gap-1 rounded border border-accent-500/40 bg-accent-600/15 px-1.5 py-0.5 text-[11px] text-accent-200 hover:bg-accent-600/25"
          onClick={() => onRegenShot?.(activeClip.shotId)}
          title="重抽本段：换种子重新生成，产生新版本（旧版在「历史」里可切回）"
        >
          <RefreshCw size={10} /> 重抽本段
        </button>
      )}
      {activeClip && nextClip && (
        <button
          className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-600/15 px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-600/25"
          onClick={() => onContinueToNext?.(activeClip.shotId)}
          title={`潜空间续接：把第 ${activeClip.index} 段的末尾当作第 ${nextClip.index} 段的开头，设置下一段为潜空间续接并立即生成`}
        >
          <Link2 size={10} /> 续接下一段 →
        </button>
      )}
      {activeClip && activeClip.contMode !== 'none' && (
        <button
          className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/20"
          onClick={() => onCancelContinue?.(activeClip.shotId)}
          title="取消与上一段的续接，改为独立成段"
        >
          <Link2 size={10} /> 取消接续
        </button>
      )}
      {activeClip?.contMode === 'none' && (
        <span className="text-[11px] text-slate-600">独立成段</span>
      )}
      <span className="ml-auto text-[11px] text-slate-600">{activeClip?.frames ?? 0} 帧</span>
    </div>
  )

  /* 裁切面板 */
  const trimPanel = showTrim && (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-slate-400">
      <Scissors size={12} className="text-amber-300" />
      <span>裁切当前段（保留头/尾帧）：</span>
      <span className="text-slate-600">头</span>
      <MiniNum value={activeClip?.pinHead ?? 0} onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinHead', n)} />
      <span className="text-slate-600">尾</span>
      <MiniNum value={activeClip?.pinTail ?? 0} onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinTail', n)} />
      <span className="text-slate-600">· 生成时按保留帧参与续接</span>
      <button className="ml-auto rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={() => setShowTrim(false)}>
        <X size={12} />
      </button>
    </div>
  )

  /* 历史面板 */
  const historyPanel = showHistory && (
    <div className="border-b border-white/5 bg-white/[0.02] px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <History size={12} className="text-accent-400" />
        <span className="text-[11px] text-slate-300">第 {activeClip?.index ?? 0} 段 · 产物版本</span>
        <button className="ml-auto rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={() => setShowHistory(false)}>
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(activeClip?.takes ?? []).map((t) => (
          <div key={t.id} className="flex items-center gap-0.5">
            <button
              className={`rounded border px-2 py-1 text-[11px] ${
                t.kept ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400 hover:text-slate-200'
              }`}
              onClick={() => activeClip && onKeepTake?.(activeClip.shotId, t.id)}
              title={t.file}
            >
              {t.label}{t.kept ? ' ✓当前' : ''}
            </button>
            {(activeClip?.takes.length ?? 0) > 1 && onDeleteTake && (
              <button
                className="rounded px-1 py-1 text-[10px] text-slate-600 hover:bg-red-500/10 hover:text-red-400"
                title={t.kept ? '删除当前版本（将自动切到另一个版本）' : '删除此版本'}
                onClick={() => activeClip && onDeleteTake(activeClip.shotId, t.id)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  const meta = (
    <div className="mb-1 flex items-center gap-1.5">
      <Film size={12} className="text-accent-400" />
      <span className="text-[11px] text-slate-400">全片时间轴</span>
      <span className="text-[11px] text-slate-600">
        {generatedCount}/{clips.length} 段已渲染 · {totalFrames} 帧 · {totalSec.toFixed(2)}s
      </span>
      <span className="ml-auto flex items-center gap-1">
        <button className="rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={() => zoom(1 / 1.6)} title="缩小">
          <ZoomOut size={12} />
        </button>
        <button className="rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={fit} title="适配宽度">
          <Maximize2 size={12} />
        </button>
        <button className="rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={() => zoom(1.6)} title="放大">
          <ZoomIn size={12} />
        </button>
      </span>
    </div>
  )

  const timeline = (
    <div className="shrink-0">
      {toolbar}
      {segToolRow}
      {trimPanel}
      {historyPanel}
      <div className="px-3 pb-2 pt-2">
        {meta}
        <div
          ref={bandRef}
          className="relative overflow-x-auto overflow-y-hidden rounded border border-white/5 bg-ink-950/60"
          style={{ cursor: 'crosshair' }}
          onMouseDown={onBandDown}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault()
              zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
            }
          }}
        >
          <div ref={trackRef} className="relative" style={{ width: `${contentW}px`, minHeight: 76 }}>
            {/* 刻度 */}
            <div className="relative h-4 border-b border-white/5">
              {ticks.map((t) => (
                <div key={t.label + t.x} className="absolute top-0 h-full" style={{ left: `${t.x}px` }}>
                  <div className="h-1.5 w-px bg-white/15" />
                  <span className="ml-0.5 whitespace-nowrap text-[11px] leading-none text-slate-600">{t.label}</span>
                </div>
              ))}
            </div>

            {/* 段块：按帧长首尾相接，自动拼接成一条 */}
            <div className="relative" style={{ height: 42 }}>
              {clips.map((c) => {
                const left = (starts[c.shotId] ?? 0) * pxPerFrame
                const w = Math.max(2, c.frames * pxPerFrame)
                const isCur = c.shotId === clip?.shotId
                const isSel = Boolean(activeShotId && c.shotId === activeShotId)
                return (
                  <div
                    key={c.shotId}
                    className={`absolute top-0 overflow-hidden rounded-sm border ${
                      isSel ? 'border-accent-400' : isCur ? 'border-accent-500/60' : 'border-white/10'
                    }`}
                    style={{ left: `${left}px`, width: `${w}px`, height: 40 }}
                    title={`第 ${c.index} 段 · ${c.frames} 帧 · ${c.file ? '已生成' : '待生成'}${
                      c.contMode !== 'none' ? ' · 续接' : ''
                    }`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      // 点段块：精确定位到点击的那一帧，并从该帧开始播放
                      if (c.file && urls[c.shotId]) {
                        // 只有切到"另一段"时 activeShotId effect 才会跑；点当前段则自己清标记
                        seekingByClickRef.current = c.shotId !== activeShotId
                        seekFrame(Math.round(frameAtClientX(e.clientX)), true)
                      }
                      if (c.shotId && onSelectShot) onSelectShot(c.shotId)
                    }}
                  >
                    {c.file ? (
                      <ClipThumb url={urls[c.shotId]} />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-[11px] text-slate-600">
                        待生成
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/55 px-1 text-[11px] leading-4 text-slate-200">
                      <span className="truncate">第{c.index}段</span>
                      {c.takes.length > 1 && (
                        <button
                          className="shrink-0 rounded bg-sky-500/25 px-1 text-sky-200 hover:bg-sky-500/40"
                          title={`本段有 ${c.takes.length} 个版本，点此选择`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenTakeMenu((cur) => (cur === c.shotId ? null : c.shotId))
                          }}
                        >
                          ×{c.takes.length}▾
                        </button>
                      )}
                      {c.contMode !== 'none' && <span className="text-amber-300">续</span>}
                      {!c.file && <span className="text-slate-400">未渲染</span>}
                    </div>
                  </div>
                )
              })}

              {/* 段块版本选择浮层（脱离段块的 overflow-hidden） */}
              {openTakeMenu && (() => {
                const target = clips.find((c) => c.shotId === openTakeMenu)
                if (!target) return null
                const left = (starts[target.shotId] ?? 0) * pxPerFrame
                // 打开菜单时懒加载各版本的实际时长（metadata），与段设定不一致的标 ⚠
                const segDur = target.durationSec || 0
                return (
                  <div
                    className="absolute top-0 z-30 min-w-[150px] rounded border border-sky-500/40 bg-ink-900 p-1 shadow-xl"
                    style={{ left: `${Math.max(0, left)}px`, top: 4 }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="mb-1 px-1 text-[11px] text-slate-500">第 {target.index} 段 · 选版本（设定 {segDur.toFixed(1)}s）</div>
                    {target.takes.map((t) => {
                      const dur = takeDurations[t.id]
                      const mismatch = dur !== undefined && segDur > 0 && Math.abs(dur - segDur) > 0.6
                      // 至少保留一个版本：只剩一个时不允许删除（无论是否 kept）
                      const canDelete = target.takes.length > 1 && !!onDeleteTake
                      return (
                        <div key={t.id} className="flex items-center gap-0.5">
                          <button
                            className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-white/5 ${
                              t.kept ? 'text-emerald-300' : 'text-slate-400'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation()
                              onKeepTake?.(target.shotId, t.id)
                              setOpenTakeMenu(null)
                            }}
                          >
                            <span className="truncate">
                              {t.label}
                              {dur !== undefined && (
                                <span className={mismatch ? 'ml-1 text-amber-400' : 'ml-1 text-slate-600'}>
                                  {dur.toFixed(1)}s{mismatch ? ' ⚠旧参数' : ''}
                                </span>
                              )}
                            </span>
                            {t.kept && <span className="shrink-0">✓当前</span>}
                          </button>
                          {canDelete && (
                            <button
                              className="shrink-0 rounded px-1 py-1 text-[11px] text-slate-600 hover:bg-red-500/10 hover:text-red-400"
                              title={t.kept ? '删除当前版本（将自动切到另一个版本）' : '删除此版本'}
                              onClick={(e) => {
                                e.stopPropagation()
                                onDeleteTake?.(target.shotId, t.id)
                                setOpenTakeMenu(null)
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )
                    })}
                    <button
                      className="mt-1 w-full rounded border-t border-white/10 px-1 py-1 text-left text-[11px] text-slate-600 hover:text-slate-300"
                      onClick={(e) => { e.stopPropagation(); setOpenTakeMenu(null) }}
                    >
                      关闭
                    </button>
                  </div>
                )
              })()}
            </div>

            {/* 波形 */}
            <div className="relative border-t border-white/5" style={{ height: 30 }}>
              <canvas ref={waveRef} className="block" />
            </div>

            {/* 打点标记 */}
            {marks.map((m, i) => (
              <div
                key={i}
                className="pointer-events-none absolute top-0 bottom-0 z-[5]"
                style={{ left: `${m * pxPerFrame}px` }}
              >
                <div className="h-full w-px border-l border-dashed border-amber-400/60" />
              </div>
            ))}

            {/* 播放头 + 浮动小工具栏：播放时 left 加 80ms 线性过渡让移动更顺滑；拖动 scrub 时移除以保证跟手 */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10"
              style={{
                left: `${globalFrame * pxPerFrame}px`,
                transition: dragging ? 'none' : 'left 80ms linear',
                willChange: 'left'
              }}
            >
              <div className="h-full w-px bg-rose-500" />
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-rose-500" />
              <div className="pointer-events-auto absolute -top-[3px] left-1 flex items-center gap-0.5 rounded border border-white/10 bg-ink-900/95 px-0.5 shadow-lg">
                <button
                  className="rounded p-0.5 text-slate-400 hover:text-amber-300"
                  title="在此打点"
                  onClick={() => setMarks((prev) => [...prev, Math.round(globalFrame)])}
                >
                  <span className="block h-2 w-2 rounded-full border border-current" />
                </button>
                <button
                  className="rounded p-0.5 text-slate-400 hover:text-amber-300"
                  title="分割（在此处打点标记）"
                  onClick={() => setMarks((prev) => [...prev, Math.round(globalFrame)])}
                >
                  <MoreHorizontal size={11} />
                </button>
                <button
                  className="rounded p-0.5 text-slate-400 hover:text-slate-100"
                  title="放大"
                  onClick={() => zoom(1.6)}
                >
                  <Plus size={11} />
                </button>
                <button
                  className="rounded p-0.5 text-slate-400 hover:text-slate-100"
                  title="缩小"
                  onClick={() => zoom(1 / 1.6)}
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 状态栏 */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
          <span className="tabular-nums text-slate-300">{fmt(globalFrame / fpsSafe)} / {fmt(totalSec)}</span>
          <span className="tabular-nums">第 {Math.round(globalFrame)} / {totalFrames} 帧</span>
          <span>{generatedCount} / {clips.length} 段已渲染</span>
          <span>全片 {fmt(totalSec)}</span>
          <span className="ml-auto">当前段 {clip?.frames ?? 0} 帧</span>
        </div>
      </div>
    </div>
  )

  return <>{render({ viewer, timeline, meta })}</>
}
