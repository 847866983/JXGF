import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, Clapperboard, Film, History, Link2, Maximize2, MoreHorizontal,
  Pause, Play, Plus, Scissors, Send, SkipBack, SkipForward, Upload, X, ZoomIn, ZoomOut
} from 'lucide-react'

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
  takes?: LocalTake[]
  onSelectShot?: (shotId: string) => void
  onAppendShot?: () => void
  onExportFilm?: (file: string, name: string) => void
  onPushWhole?: () => void
  onOpenHistory?: () => void
  onOpenProjects?: () => void
  onTrim?: () => void
  onPatchPin?: (shotId: string, field: 'pinHead' | 'pinTail', value: number) => void
  onCancelContinue?: (shotId: string) => void
  onKeepTake?: (takeId: string) => void
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
      className="h-5 w-10 rounded border border-white/10 bg-ink-950/70 px-1 text-center text-[10px] text-slate-200 outline-none focus:border-accent/60"
    />
  )
}

export default function LocalFilm({
  clips,
  fps,
  activeShotId,
  takes = [],
  onSelectShot,
  onAppendShot,
  onExportFilm,
  onPushWhole,
  onOpenHistory,
  onOpenProjects,
  onTrim,
  onPatchPin,
  onCancelContinue,
  onKeepTake,
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

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef(false)
  /** 连续播放意图：切段后新视频加载完成时要不要自动播 */
  const wantPlayRef = useRef(false)
  /** 手动 seek 的段内目标时间；新视频加载后定位到这里 */
  const seekTargetRef = useRef<number | null>(null)

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
      if (first >= 0) setIdx(first)
    }
  }, [clips, idx])

  const clip = clips[idx]
  const url = clip ? urls[clip.shotId] : undefined
  const globalFrame = Math.min(
    totalFrames,
    (clip ? starts[clip.shotId] ?? 0 : 0) + curTime * fpsSafe
  )

  const playAt = (i: number): void => {
    wantPlayRef.current = true
    seekTargetRef.current = null
    setIdx(i)
    setCurTime(0)
    setPlaying(true)
  }

  const toggle = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      wantPlayRef.current = true
      void v.play().catch(() => undefined)
    } else {
      wantPlayRef.current = false
      v.pause()
    }
  }

  /* 新视频元数据就绪：应用手动 seek 目标；若处于连续播放意图则真正开播 */
  const onLoadedData = (e: React.SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget
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
    if (wantPlayRef.current && v.paused) void v.play().catch(() => undefined)
  }

  /* 一段播完自动接下一段（跳过未生成的），实现整片连续播放 */
  const onEnded = (): void => {
    let n = idx + 1
    while (n < clips.length && !clips[n].file) n += 1
    if (n < clips.length) playAt(n)
    else {
      wantPlayRef.current = false
      setPlaying(false)
    }
  }

  /* 时间轴点击 / 拖动：把全局帧换算成 (段, 段内时间) */
  const seekFrame = (f: number): void => {
    const clamped = Math.max(0, Math.min(totalFrames, f))
    let acc = 0
    for (let i = 0; i < clips.length; i += 1) {
      const end = acc + clips[i].frames
      if (clamped < end || i === clips.length - 1) {
        if (clips[i].file && urls[clips[i].shotId]) {
          const t = (clamped - acc) / fpsSafe
          wantPlayRef.current = false
          seekTargetRef.current = t
          setIdx(i)
          setCurTime(t)
          const v = videoRef.current
          if (v && clips[i].shotId === clip?.shotId) {
            try {
              v.currentTime = Math.max(0, t)
            } catch {
              /* 元数据未就绪 */
            }
          }
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

  const onBandDown = (e: React.MouseEvent): void => {
    dragRef.current = true
    seekFrame(Math.round(frameAtClientX(e.clientX)))
  }
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (dragRef.current) seekFrame(Math.round(frameAtClientX(e.clientX)))
    }
    const up = (): void => {
      dragRef.current = false
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
    opts: { primary?: boolean; disabled?: boolean; title?: string } = {}
  ): React.JSX.Element => (
    <button
      className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-40 ${
        opts.primary
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
      {clip?.file && clip.kind === 'video' ? (
        url ? (
          <video
            key={clip.shotId}
            ref={videoRef}
            src={url}
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
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-500">
          这一段还没有成片 —— 先生成任意一段，整片预览就会出现在这里
        </div>
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
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            onClick={toggle}
            title={playing ? '暂停' : '连续播放整片'}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
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
      <div className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-[10px] text-slate-200">
        第 {clip?.index ?? 0} 段 / 共 {generatedCount} 段 · {fmt(globalFrame / fpsSafe)} / {fmt(totalSec)}
      </div>
    </div>
  )

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 px-3 py-2">
      <Clapperboard size={13} className="text-accent-400" />
      <span className="mr-1 text-[11px] font-medium text-slate-200">全片总览</span>
      <span className="mr-2 text-[10px] text-slate-600">{clips.length} 段</span>
      {toolBtn('接一段', <Plus size={11} />, onAppendShot, { title: '在时间轴末尾追加一段新分镜' })}
      {toolBtn('裁切', <Scissors size={11} />, () => setShowTrim((v) => !v), {
        title: '裁切：调整当前段保留的头/尾帧'
      })}
      {toolBtn('导出成片', <Upload size={11} />, () => {
        if (clip?.file) onExportFilm?.(clip.file, `第${clip.index}段`)
      }, { disabled: !clip?.file, title: '把当前段成片另存到本地' })}
      {toolBtn('推送整片', <Send size={11} />, onPushWhole, { title: '把拼接后的整片登记为后续段的视频参考' })}
      {toolBtn('历史', <History size={11} />, () => setShowHistory((v) => !v), {
        disabled: takes.length === 0,
        title: '查看/切换当前段的产物版本'
      })}
      <div className="relative ml-auto">
        <button
          className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200"
          onClick={() => setShowProjects((v) => !v)}
        >
          工程 <ChevronDown size={11} />
        </button>
        {showProjects && (
          <div className="absolute right-0 top-full z-30 mt-1 w-32 rounded border border-white/10 bg-ink-900 p-1 shadow-xl">
            <button
              className="w-full rounded px-2 py-1.5 text-left text-[10px] text-slate-300 hover:bg-white/5"
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

  /* 段工具行：第 N 段 / 保留头尾 / 取消接续 */
  const segToolRow = (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-white/[0.015] px-3 py-1.5">
      <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-200">
        第 {activeClip?.index ?? 0} 段
      </span>
      <span className="text-[10px] text-slate-500">保留</span>
      <MiniNum
        value={activeClip?.pinHead ?? 0}
        title="保留头帧"
        onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinHead', n)}
      />
      <span className="text-[10px] text-slate-500">头</span>
      <MiniNum
        value={activeClip?.pinTail ?? 0}
        title="保留尾帧"
        onCommit={(n) => activeClip && onPatchPin?.(activeClip.shotId, 'pinTail', n)}
      />
      <span className="text-[10px] text-slate-500">尾</span>
      {activeClip && activeClip.contMode !== 'none' && (
        <button
          className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/20"
          onClick={() => onCancelContinue?.(activeClip.shotId)}
          title="取消与上一段的续接，改为独立成段"
        >
          <Link2 size={10} /> 取消接续
        </button>
      )}
      {activeClip?.contMode === 'none' && (
        <span className="text-[10px] text-slate-600">独立成段</span>
      )}
      <span className="ml-auto text-[10px] text-slate-600">{activeClip?.frames ?? 0} 帧</span>
    </div>
  )

  /* 裁切面板 */
  const trimPanel = showTrim && (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-amber-500/[0.04] px-3 py-2 text-[10px] text-slate-400">
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
        <span className="text-[10px] text-slate-300">第 {activeClip?.index ?? 0} 段 · 产物版本</span>
        <button className="ml-auto rounded p-0.5 text-slate-500 hover:text-slate-200" onClick={() => setShowHistory(false)}>
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {takes.map((t) => (
          <button
            key={t.id}
            className={`rounded border px-2 py-1 text-[10px] ${
              t.kept ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400 hover:text-slate-200'
            }`}
            onClick={() => onKeepTake?.(t.id)}
            title={t.file}
          >
            {t.label}{t.kept ? ' ✓当前' : ''}
          </button>
        ))}
      </div>
    </div>
  )

  const meta = (
    <div className="mb-1 flex items-center gap-1.5">
      <Film size={12} className="text-accent-400" />
      <span className="text-[10px] text-slate-400">全片时间轴</span>
      <span className="text-[10px] text-slate-600">
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
                  <span className="ml-0.5 whitespace-nowrap text-[9px] leading-none text-slate-600">{t.label}</span>
                </div>
              ))}
            </div>

            {/* 段块：按帧长首尾相接，自动拼接成一条 */}
            <div className="relative" style={{ height: 42 }}>
              {clips.map((c, i) => {
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
                    onClick={() => {
                      if (c.shotId && onSelectShot) onSelectShot(c.shotId)
                      if (c.file) playAt(i)
                    }}
                  >
                    {c.file ? (
                      <ClipThumb url={urls[c.shotId]} />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-[9px] text-slate-600">
                        待生成
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/55 px-1 text-[9px] leading-4 text-slate-200">
                      <span className="truncate">第{c.index}段</span>
                      {c.contMode !== 'none' && <span className="text-amber-300">续</span>}
                      {!c.file && <span className="text-slate-400">未渲染</span>}
                    </div>
                  </div>
                )
              })}
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

            {/* 播放头 + 浮动小工具栏 */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10"
              style={{ left: `${globalFrame * pxPerFrame}px` }}
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
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
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
