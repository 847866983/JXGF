import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Maximize2, Pause, Play, ZoomIn, ZoomOut } from 'lucide-react'

/**
 * 成片监视器 + 时间轴 —— 照搬节点包 js/csglide_film.js 的「成片监视器」。
 *
 * 数据来自 ComfyUI 的两个只读接口（与网页端导演台同一份真值）：
 *   GET /cglide/chain/film_summary   每段在全片里的净起止帧、累积成片、承接帧数、版本
 *   GET /cglide/join/waveform        整条成片的音频峰值包络
 *   GET /cglide/join/sprite          段块底片条（一次解码抽 N 张拼成一张）
 *   GET /cglide/join/video           成片流（支持 Range，可 seek）
 *
 * 关键口径（与后端 _head_trim_of / film_summary 一致）：
 *   段块宽度 = clip_to - clip_from = frames - trim_frames - trim_tail（**净长**）
 *   承接的那几帧属于上一段，不重复占本段宽度；成片文件里也已经剪掉了。
 */

export interface FilmClip {
  id: string
  index: number
  name: string
  shot: string
  frames: number
  clip_from: number
  clip_to: number
  film: string | null
  film_frames: number
  film_head: number
  playable: boolean
  take: number
  takes: number
  trim_frames: number
  trim_tail: number
  pending?: string | null
  locked?: boolean
  w?: number | null
  h?: number | null
}

export interface FilmSummary {
  name?: string
  fps?: number
  total_frames?: number
  seconds?: number
  clips?: FilmClip[]
  head?: string | null
  current?: string | null
  missing?: string[]
  error?: string
}

interface Props {
  chainName: string
  /** 档案里的 shot（= 工程分镜 id）→ 工程里的分镜 id */
  selectedShotId?: string
  onSelectShot?: (shotId: string, clip: FilmClip) => void
  /** 变更这个值会重新拉一次 film_summary（生成完成后调用） */
  refreshKey?: number
}

const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}

export default function FilmMonitor({
  chainName,
  selectedShotId,
  onSelectShot,
  refreshKey = 0
}: Props): React.JSX.Element {
  const [sum, setSum] = useState<FilmSummary | null>(null)
  const [base, setBase] = useState('http://127.0.0.1:8188')
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pxPerFrame, setPxPerFrame] = useState(0)
  const [wave, setWave] = useState<number[]>([])
  const [err, setErr] = useState<string | null>(null)

  const bandRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)

  const fps = sum?.fps || 24
  const total = Math.max(1, Math.round(sum?.total_frames || 0))
  const clips = useMemo(() => sum?.clips ?? [], [sum])

  /* ---------- 载入整片视图 ---------- */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const b = await window.api.cglideBase()
        if (alive) setBase(b)
        const r = (await window.api.cglideFilmSummary(chainName)) as FilmSummary
        if (!alive) return
        if (r?.error) {
          setErr(r.error)
          setSum(null)
          return
        }
        setErr(null)
        setSum(r)
        setFrame(0)
      } catch (e) {
        if (alive) setErr(String((e as Error).message ?? e))
      }
    })()
    return () => {
      alive = false
    }
  }, [chainName, refreshKey])

  /* ---------- 整片源：取最后一段「可播」的累积成片 ---------- */
  const fullFilm = useMemo(() => {
    let f: string | null = null
    for (const c of clips) if (c.playable && c.film) f = c.film
    return f
  }, [clips])
  const videoUrl = fullFilm
    ? `${base}/cglide/join/video?video=${encodeURIComponent(fullFilm)}&play=1`
    : ''

  /* ---------- 波形（整条成片） ---------- */
  useEffect(() => {
    if (!fullFilm) {
      setWave([])
      return
    }
    let alive = true
    void (async () => {
      const r = await window.api.cglideJoinWaveform(fullFilm, 1200)
      if (alive && Array.isArray(r?.bins)) setWave(r.bins)
      else if (alive) setWave([])
    })()
    return () => {
      alive = false
    }
  }, [fullFilm])

  /* ---------- 适配宽度：整条片铺满 ---------- */
  const fit = useCallback(() => {
    const vw = bandRef.current?.clientWidth ?? 0
    if (vw < 60 || total < 2) return
    setPxPerFrame(vw / total)
  }, [total])

  useEffect(() => {
    fit()
  }, [fit, sum])

  useEffect(() => {
    const el = bandRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  const contentW = Math.max(1, pxPerFrame * total)

  /* ---------- 播放头 / 视频同步 ---------- */
  const seekTo = useCallback(
    (f: number) => {
      const v = videoRef.current
      const clamped = Math.max(0, Math.min(total, f))
      setFrame(clamped)
      if (v && videoUrl) {
        const t = clamped / fps
        if (Number.isFinite(t) && Math.abs(v.currentTime - t) > 0.02) {
          try {
            v.currentTime = t
          } catch {
            /* 元数据未就绪，忽略 */
          }
        }
      }
    },
    [fps, total, videoUrl]
  )

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = (): void => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        setFrame(Math.min(total, v.currentTime * fps))
      })
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('seeked', onTime)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('seeked', onTime)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [fps, total, videoUrl])

  const togglePlay = (): void => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }

  /* ---------- 时间轴交互 ---------- */
  const frameAtClientX = (clientX: number): number => {
    const band = bandRef.current
    const track = trackRef.current
    if (!band || !track || pxPerFrame <= 0) return 0
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(total, (clientX - rect.left) / pxPerFrame))
  }

  const onBandClick = (e: React.MouseEvent): void => {
    seekTo(Math.round(frameAtClientX(e.clientX)))
  }

  const dragRef = useRef(false)
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (dragRef.current) seekTo(Math.round(frameAtClientX(e.clientX)))
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
  }, [pxPerFrame, total])

  const zoom = (factor: number): void => {
    setPxPerFrame((p) => {
      const vw = bandRef.current?.clientWidth ?? 600
      const min = vw / total
      return Math.max(min, Math.min(8, (p || min) * factor))
    })
  }

  /* ---------- 波形绘制 ---------- */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const w = Math.max(1, Math.round(contentW))
    const h = 34
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
    ctx.fillStyle = 'rgba(122, 92, 255, 0.55)'
    const mid = h / 2
    const step = w / wave.length
    for (let i = 0; i < wave.length; i += 1) {
      const v = Math.max(0, Math.min(1, Number(wave[i]) || 0))
      const bh = Math.max(1, v * (h - 4))
      ctx.fillRect(i * step, mid - bh / 2, Math.max(step * 0.8, 0.6), bh)
    }
  }, [wave, contentW])

  /* ---------- 刻度 ---------- */
  const ticks = useMemo(() => {
    const totalSec = total / fps
    const stepSec = RULER_STEPS.find((s) => totalSec / s <= 8) ?? 600
    const out: { x: number; label: string }[] = []
    for (let s = 0; s <= totalSec + 0.001; s += stepSec) {
      out.push({ x: s * fps * pxPerFrame, label: fmtTime(s) })
    }
    return out
  }, [total, fps, pxPerFrame])

  const curClip =
    clips.find((c, i) => c.clip_from <= frame && (frame < c.clip_to || i === clips.length - 1)) ?? clips[0]

  if (err) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
        成片时间轴读取失败：{err}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* 取景器 */}
      <div className="relative h-[340px] shrink-0 overflow-hidden rounded-lg bg-black">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            className="h-full w-full object-contain"
            playsInline
            preload="metadata"
            onClick={togglePlay}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            还没有成片 —— 先生成任意一段，时间轴就会出现在这里
          </div>
        )}
        {/* 播放按钮 */}
        {videoUrl && (
          <button
            className="absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            onClick={togglePlay}
            title={playing ? '暂停' : '播放整片'}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
        )}
        {/* 当前段 / 时间码 */}
        <div className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-[10px] text-slate-200">
          {curClip ? `第 ${curClip.index} 段 / 共 ${clips.length} 段` : '—'} · {fmtTime(frame / fps)}
        </div>
      </div>

      {/* 时间轴 */}
      <div className="mt-2 shrink-0">
        <div className="mb-1 flex items-center gap-1.5">
          <Film size={12} className="text-accent-400" />
          <span className="text-[10px] text-slate-400">全片时间轴</span>
          <span className="text-[10px] text-slate-600">
            {clips.length} 段 · {total} 帧 · {(total / fps).toFixed(2)}s
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

        <div
          ref={bandRef}
          className="relative overflow-x-auto overflow-y-hidden rounded border border-white/5 bg-ink-950/60"
          style={{ cursor: 'crosshair' }}
          onClick={onBandClick}
          onMouseDown={() => {
            dragRef.current = true
          }}
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

            {/* 段块 + 底片条 */}
            <div className="relative" style={{ height: 46 }}>
              {clips.map((c) => {
                const left = c.clip_from * pxPerFrame
                const w = Math.max(2, (c.clip_to - c.clip_from) * pxPerFrame)
                const isCur = curClip?.id === c.id
                const isSel = selectedShotId && c.shot === selectedShotId
                const sprite =
                  c.playable && c.film
                    ? `${base}/cglide/join/sprite?video=${encodeURIComponent(c.film)}&cols=24&cw=120&f0=${c.clip_from}&f1=${c.clip_to}`
                    : ''
                return (
                  <div
                    key={c.id}
                    className={`absolute top-0 overflow-hidden rounded-sm border ${
                      isSel ? 'border-accent-400' : isCur ? 'border-accent-500/60' : 'border-white/10'
                    }`}
                    style={{ left: `${left}px`, width: `${w}px`, height: 42 }}
                    title={`第 ${c.index} 段 · ${c.frames} 帧（净 ${c.clip_to - c.clip_from}）· v${c.take}/${c.takes}${
                      c.trim_frames > 0 ? ` · 承接 ${c.trim_frames} 帧` : ''
                    }${c.playable ? '' : ' · 还没成片'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (c.shot && onSelectShot) onSelectShot(c.shot, c)
                      seekTo(c.clip_from)
                    }}
                  >
                    {sprite ? (
                      <img
                        src={sprite}
                        alt=""
                        className="h-full w-full object-cover opacity-80"
                        draggable={false}
                        style={{ objectPosition: 'left center' }}
                      />
                    ) : (
                      <div className="h-full w-full bg-white/[0.04]" />
                    )}
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/55 px-1 text-[9px] leading-4 text-slate-200">
                      <span className="truncate">第{c.index}段</span>
                      {c.takes > 1 && <span className="text-accent-300">v{c.take}</span>}
                      {c.trim_frames > 0 && <span className="text-amber-300">⇥{c.trim_frames}</span>}
                      {!c.playable && <span className="text-slate-400">{c.pending ? '待重抽' : '未渲染'}</span>}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 波形 */}
            <div className="relative border-t border-white/5" style={{ height: 34 }}>
              <canvas ref={canvasRef} className="block" />
            </div>

            {/* 播放头 */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-10" style={{ left: `${frame * pxPerFrame}px` }}>
              <div className="h-full w-px bg-accent-400" />
              <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-accent-400" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
