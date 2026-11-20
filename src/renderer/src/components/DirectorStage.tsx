import { useEffect, useState } from 'react'
import {
  Check, ChevronLeft, ChevronRight, Clapperboard, Eye, Film, Link2,
  PenLine, Play, Settings2, Wand2
} from 'lucide-react'
import type { SegmentSettings, Shot } from '@shared/types'
import { alignFrames, framesFor } from '../lib/segment'
import { MediaImage } from '../components/MediaImage'
import { VideoThumb } from '../components/VideoThumb'
import DeskPanel from './DeskPanel'
import { RefBindingPanel, type RefPick, type RefAssetOption } from './RefBindingPanel'

/**
 * 导演台 · 分段导演（照节点包网页端导演台的剪辑器布局重做）
 *
 * 三段式，视觉与操作顺序即参考图：
 *   ┌ 工具条：成片监视器 · 工程 · 段数 ｜ 切剧集 / 节点参数 / 全部渲染
 *   ├ 左：成片监视器（预览 + 生成本段）　右：段参数面板（规格 / 提示词 / 参考图 tab）
 *   └ 时间轴：全片总览 · 段块轨道（按帧长）· 刻度尺 · 批量入口
 *
 * 参数行沿用参考图的紧凑排布（label 左、控件右、行间细分隔），字段与
 * SegmentSettings 一一对应，改完即时写回。推理仍在 ComfyUI 后端。
 */

export interface DirectorStageProps {
  projectName: string
  episodes: { id: string; title: string }[]
  episodeId: string
  onEpisode: (id: string) => void
  shots: Shot[]
  curShot: Shot | null
  onSelect: (id: string) => void
  curSeg: SegmentSettings | null
  onPatch: (patch: Partial<SegmentSettings>) => void
  prompt: string
  onPrompt: (v: string) => void
  onSavePrompt: () => void
  onGenerateOne: () => void
  onGenerateAll: () => void
  canGenerate: boolean
  batchRunning: boolean
  pendingCount: number
  globalPrompt: string
  onGlobalPrompt: (v: string) => void
  onSaveGlobal: () => void
  presets: string[]
  onPresets: (list: string[]) => void
  onOpenParams: () => void
  characterNames: string[]
  refPicks: RefPick[]
  availableRefAssets: RefAssetOption[]
  onAddRef: (assetId: string) => void
  onRemoveRef: (assetId: string) => void
  aliasMode: boolean
  onToggleAlias: (v: boolean) => void
  onBindRef: (name: string) => void
  onUnbindRef: (name: string, tag: string) => void
  submitting: boolean
}

function outputOf(shot: Shot | null): { file: string; kind: string } | null {
  if (!shot || shot.outputs.length === 0) return null
  const kept = shot.outputs.find((o) => o.kept !== false)
  const last = shot.outputs[shot.outputs.length - 1]
  const pick = kept ?? last
  return pick ? { file: pick.file, kind: pick.kind } : null
}

const fieldCls =
  'h-6 rounded border border-white/10 bg-ink-950/70 px-1.5 text-[11px] text-slate-200 outline-none transition-colors focus:border-accent/60'

/** 数字格：本地文本态，失焦/回车才提交，避免输入中间态反复写盘 */
function NumCell({
  value, onCommit, min, max, step = 1, className = '', title
}: {
  value: number
  onCommit: (n: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
  title?: string
}): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (): void => {
    let n = Number(text)
    if (!Number.isFinite(n)) {
      setText(String(value))
      return
    }
    if (min !== undefined) n = Math.max(min, n)
    if (max !== undefined) n = Math.min(max, n)
    setText(String(n))
    onCommit(n)
  }
  return (
    <input
      type="number"
      title={title}
      step={step}
      className={`${fieldCls} ${className}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/** 参数行：固定宽 label + 一组紧凑控件 + 右侧说明 */
function Row({
  label, children, hint
}: {
  label: string
  children: React.ReactNode
  hint?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-[32px] items-center gap-2 border-b border-white/[0.04] px-2.5 py-1 last:border-b-0">
      <span className="w-[62px] shrink-0 text-[10px] text-slate-500">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
      {hint != null && <span className="ml-auto shrink-0 text-[10px] text-slate-600">{hint}</span>}
    </div>
  )
}

const SIZE_PRESETS: Record<string, [number, number][]> = {
  '16:9': [[576, 320], [768, 432], [960, 544], [1280, 720]],
  '9:16': [[320, 576], [432, 768], [544, 960], [720, 1280]],
  '1:1': [[512, 512], [768, 768]],
  '4:3': [[512, 384], [768, 576]],
  '3:4': [[384, 512], [576, 768]],
  '21:9': [[768, 320], [1024, 432]]
}

/** 「规格」tab：参考图的密集参数表，字段与 SegmentSettings 一一对应 */
function SpecPanel({
  seg, onPatch
}: {
  seg: SegmentSettings
  onPatch: (patch: Partial<SegmentSettings>) => void
}): React.JSX.Element {
  const [durLocal, setDurLocal] = useState(Math.round(seg.durationSec))
  const [showPins, setShowPins] = useState(false)
  useEffect(() => setDurLocal(Math.round(seg.durationSec)), [seg.durationSec])

  const patch = (p: Partial<SegmentSettings>): void => onPatch(p)
  const applyRatio = (ratio: string): void => {
    const [w, h] = SIZE_PRESETS[ratio]?.[0] ?? [seg.width, seg.height]
    patch({ ratio, width: w, height: h })
  }
  const imgMatch = seg.refImageSize === 'match' || seg.refImageSize === 'match_canvas'
  const vidMatch = seg.refVideoSize === seg.width
  const stages = seg.stages ?? { first: true, second: true, third: true, superRes: false }

  const commitDur = (): void => patch({ durationSec: durLocal, frames: framesFor(durLocal, seg.fps) })
  const commitFrames = (f: number): void => {
    const af = alignFrames(f)
    patch({ frames: af, durationSec: Math.round(((af - 1) / seg.fps) * 100) / 100 })
  }

  return (
    <div>
      <Row label="画布" hint={`${((seg.width * seg.height) / 1e6).toFixed(2)} MP`}>
        <select
          className={`${fieldCls} w-[62px]`}
          value={seg.ratio}
          onChange={(e) => applyRatio(e.target.value)}
        >
          {Object.keys(SIZE_PRESETS).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select
          className={`${fieldCls} w-[92px]`}
          value={`${seg.width}x${seg.height}`}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number)
            patch({ width: w, height: h })
          }}
        >
          {(SIZE_PRESETS[seg.ratio] ?? []).map(([w, h]) => (
            <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} x {h}</option>
          ))}
          {!SIZE_PRESETS[seg.ratio]?.some(([w, h]) => w === seg.width && h === seg.height) && (
            <option value={`${seg.width}x${seg.height}`}>{seg.width} x {seg.height}</option>
          )}
        </select>
        <NumCell value={seg.width} onCommit={(w) => patch({ width: w })} className="w-14" min={64} />
        <span className="text-[11px] text-slate-600">×</span>
        <NumCell value={seg.height} onCommit={(h) => patch({ height: h })} className="w-14" min={64} />
      </Row>

      <Row label="时长" hint={`${seg.fps} fps`}>
        <input
          type="range"
          min={1}
          max={30}
          step={1}
          value={durLocal}
          onChange={(e) => setDurLocal(Number(e.target.value))}
          onPointerUp={commitDur}
          onKeyUp={commitDur}
          className="h-1.5 w-28 cursor-pointer accent-[#7c5cff]"
          title="拖动设定秒数"
        />
        <NumCell value={durLocal} onCommit={(d) => { setDurLocal(d); patch({ durationSec: d, frames: framesFor(d, seg.fps) }) }} className="w-12" min={1} />
        <span className="text-[10px] text-slate-600">秒</span>
        <NumCell value={seg.frames} onCommit={commitFrames} className="w-14" min={5} />
        <span className="text-[10px] text-slate-600">帧</span>
      </Row>

      <Row label="图片参考" hint={`长边 ${imgMatch ? seg.width : seg.refImageSize}px`}>
        <input
          type="checkbox"
          className="accent-[#7c5cff]"
          checked={imgMatch}
          onChange={(e) => patch({ refImageSize: e.target.checked ? 'match' : String(seg.width) })}
        />
        <span className="text-[10px] text-slate-500">跟画布</span>
        <NumCell
          value={imgMatch ? seg.width : Number(seg.refImageSize) || seg.width}
          onCommit={(n) => patch({ refImageSize: String(n) })}
          className="w-14"
          min={64}
        />
      </Row>

      <Row label="视频参考" hint={`长边 ${seg.refVideoSize}px`}>
        <input
          type="checkbox"
          className="accent-[#7c5cff]"
          checked={vidMatch}
          onChange={(e) => patch({ refVideoSize: e.target.checked ? seg.width : 768 })}
        />
        <span className="text-[10px] text-slate-500">跟画布</span>
        <NumCell value={seg.refVideoSize} onCommit={(n) => patch({ refVideoSize: n })} className="w-14" min={64} />
        <NumCell value={seg.refVideoFps} onCommit={(n) => patch({ refVideoFps: n })} className="w-12" min={1} />
        <span className="text-[10px] text-slate-600">fps</span>
      </Row>

      <Row label="放大重叠" hint={seg.refScaleHd === 1 ? '不额外缩放' : undefined}>
        <span className="text-[10px] text-slate-500">参考档位倍数</span>
        <NumCell value={seg.refScaleHd} onCommit={(n) => patch({ refScaleHd: n })} className="w-12" step={0.1} min={0.1} />
      </Row>

      <Row label="抽帧" hint={seg.rife.fps >= 24 ? '不抽帧' : `抽到 ${seg.rife.fps} fps`}>
        <NumCell
          value={seg.rife.fps}
          onCommit={(n) => patch({ rife: { ...seg.rife, fps: n } })}
          className="w-12"
          min={1}
        />
        <span className="text-[10px] text-slate-600">fps</span>
        <label className="ml-2 flex items-center gap-1 text-[10px] text-slate-500">
          <input
            type="checkbox"
            className="accent-[#7c5cff]"
            checked={seg.rife.enabled}
            onChange={(e) => patch({ rife: { ...seg.rife, enabled: e.target.checked } })}
          />
          启用插帧
        </label>
      </Row>

      <Row label="语义桥">
        <input
          className={`${fieldCls} w-[92px]`}
          value={seg.bridgeAdapter}
          onChange={(e) => patch({ bridgeAdapter: e.target.value })}
          placeholder="默认(v1)"
          title="语义桥模型 / adapter"
        />
        <select
          className={`${fieldCls} w-[64px]`}
          value={seg.bridgeMode}
          onChange={(e) => patch({ bridgeMode: e.target.value })}
          title="范围"
        >
          <option value="full">全量</option>
          <option value="head">首帧</option>
          <option value="tail">尾帧</option>
        </select>
        <span className="text-[10px] text-slate-600">强度</span>
        <NumCell value={seg.bridgeAlpha} onCommit={(n) => patch({ bridgeAlpha: n })} className="w-12" step={0.1} />
      </Row>

      <Row label="整片空间">
        <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <input
            type="checkbox"
            className="accent-[#7c5cff]"
            checked={seg.pushWhole}
            onChange={(e) => patch({ pushWhole: e.target.checked })}
          />
          发送（把整片潜空间带到下一段）
        </label>
      </Row>

      <Row label="首尾帧" hint="多参考模式下不参与">
        <button
          className="rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
          onClick={() => setShowPins((v) => !v)}
        >
          {showPins ? '收起 ▲' : '展开 ▼'}
        </button>
        {showPins && (
          <>
            <span className="text-[10px] text-slate-600">头</span>
            <NumCell value={seg.pinHead} onCommit={(n) => patch({ pinHead: n })} className="w-12" min={0} />
            <span className="text-[10px] text-slate-600">尾</span>
            <NumCell value={seg.pinTail} onCommit={(n) => patch({ pinTail: n })} className="w-12" min={0} />
          </>
        )}
      </Row>

      <div className="mt-1.5 border-t border-white/10 px-2.5 pt-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-600">生成</div>
        <Row label="方式">
          {([
            ['ref2va', '参考图'], ['video', '参考视频'], ['t2v', '纯文生']
          ] as const).map(([m, label]) => (
            <button
              key={m}
              className={`rounded px-2 py-0.5 text-[10px] ${
                seg.genMode === m ? 'bg-accent-600/30 text-accent-200 ring-1 ring-accent-500/60' : 'bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
              onClick={() => patch({ genMode: m })}
            >{label}</button>
          ))}
        </Row>
        <Row label="续接" hint={seg.contMode === 'none' ? '独立成段' : '接上一段尾帧'}>
          <select
            className={`${fieldCls} w-[118px]`}
            value={seg.contMode}
            onChange={(e) => patch({ contMode: e.target.value as SegmentSettings['contMode'] })}
          >
            <option value="none">不续接</option>
            <option value="latent">潜空间续接</option>
            <option value="video">视频续接</option>
          </select>
          {seg.contMode !== 'none' && (
            <>
              <NumCell
                value={seg.contFrames ?? 22}
                onCommit={(n) => patch({ contFrames: n })}
                className="w-12"
                min={0}
                title="承接帧数 5/22/39/56/73…"
              />
              <span className="text-[10px] text-slate-600">承接帧</span>
            </>
          )}
        </Row>
        <Row label="阶段">
          {([
            ['first', '一采'], ['second', '二采'], ['third', '三采'], ['superRes', '超分']
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1 text-[10px] text-slate-400">
              <input
                type="checkbox"
                className="accent-[#7c5cff]"
                checked={stages[k]}
                onChange={(e) => patch({ stages: { ...stages, [k]: e.target.checked } })}
              />
              {label}
            </label>
          ))}
        </Row>
      </div>
    </div>
  )
}

export default function DirectorStage(props: DirectorStageProps): React.JSX.Element {
  const { shots, curShot, curSeg, prompt } = props
  const [tab, setTab] = useState<'spec' | 'prompt' | 'ref'>('spec')

  // 提示词自动保存（停顿 1.2 秒）；失焦也立刻保存
  useEffect(() => {
    if (!curShot) return
    const timer = window.setTimeout(() => props.onSavePrompt(), 1200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt])

  const curIndex = curShot ? shots.indexOf(curShot) : -1
  const out = outputOf(curShot)
  const prev = curIndex > 0 ? shots[curIndex - 1] : null
  const next = curIndex >= 0 && curIndex < shots.length - 1 ? shots[curIndex + 1] : null
  const pick = (shot: Shot | null): void => {
    if (shot) props.onSelect(shot.id)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ============ 顶栏：成片监视器 / 工程 / 段数 / 全局操作 ============ */}
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <Film size={14} className="text-accent-400" />
          <span className="text-xs font-medium text-slate-200">成片监视器</span>
          <span className="text-[10px] text-slate-600">
            {props.projectName} · {shots.length} 段 · 待生成 <span className="text-amber-300">{props.pendingCount}</span>
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className={`${fieldCls} w-[150px]`}
            value={props.episodeId}
            onChange={(e) => props.onEpisode(e.target.value)}
            title="切换剧集"
          >
            {props.episodes.map((ep) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
          </select>
          <button className="btn-ghost px-2.5 py-1 text-[11px]" onClick={props.onOpenParams} title="SLA / 显存 / Sigma / 视频合成 / RTX / LoRA 等全片节点参数">
            <Settings2 size={12} /> 节点参数
          </button>
          <button
            className="btn-primary px-2.5 py-1 text-[11px]"
            disabled={!props.canGenerate || props.batchRunning || props.pendingCount === 0}
            onClick={props.onGenerateAll}
            title="按时间轴顺序批量渲染未生成的段，已生成的跳过"
          >
            <Play size={12} /> {props.batchRunning ? '渲染中…' : '全部渲染'}
          </button>
        </div>
      </div>

      {/* ============ 主体：左监视器 / 右参数面板 ============ */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.06fr)] gap-3">
        {/* 左：成片监视器 */}
        <section className="panel flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
            <Eye size={13} className="text-accent-400" />
            <span className="text-[11px] font-medium text-slate-300">预览</span>
            <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-slate-400">
              第 {curIndex + 1} 段
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <button className="rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25" disabled={!prev} onClick={() => pick(prev)} title="上一段"><ChevronLeft size={14} /></button>
              <button className="rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25" disabled={!next} onClick={() => pick(next)} title="下一段"><ChevronRight size={14} /></button>
            </div>
          </div>
          <div className="relative flex-1 bg-black" style={{ minHeight: 400 }}>
            {out ? (
              out.kind === 'video' ? (
                <VideoThumb src={out.file} className="h-full w-full object-contain" />
              ) : (
                <MediaImage src={out.file} alt="" className="h-full w-full object-contain" fallback={<div className="h-full w-full" />} />
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]">
                  <Play size={16} className="ml-0.5 text-slate-600" />
                </span>
                <span className="text-xs text-slate-400">这一段还没有成片</span>
                <span className="max-w-[240px] text-[10px] leading-relaxed text-slate-600">
                  在右侧写好提示词、绑好参考图，点下方「生成本段」试试效果
                </span>
              </div>
            )}
            {props.submitting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-accent-200">正在生成…</div>
            )}
          </div>
          <div className="border-t border-white/5 p-2.5">
            <button className="btn-primary w-full" disabled={!curShot || props.submitting} onClick={props.onGenerateOne}>
              <Wand2 size={13} /> {props.submitting ? '提交中…' : '生成本段'}
            </button>
          </div>
        </section>

        {/* 右：段参数面板 */}
        <section className="panel flex flex-col overflow-hidden" style={{ maxHeight: 580 }}>
          <div className="flex items-center border-b border-white/5 px-2.5">
            {([
              ['spec', '规格', <Settings2 key="i" size={12} />],
              ['prompt', '提示词', <PenLine key="i" size={12} />],
              ['ref', '参考图', <Link2 key="i" size={12} />]
            ] as const).map(([k, label, icon]) => (
              <button
                key={k}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[11px] transition-colors ${
                  tab === k
                    ? 'border-accent-500 text-accent-200'
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
                onClick={() => setTab(k)}
              >
                {icon}{label}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-slate-600">第 {curIndex + 1} 段</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!curShot || !curSeg ? (
              <div className="px-3 py-16 text-center text-xs text-slate-500">
                这个剧集还没有分段，请先在「剧本与分镜」里添加分镜
              </div>
            ) : tab === 'spec' ? (
              <SpecPanel seg={curSeg} onPatch={props.onPatch} />
            ) : tab === 'prompt' ? (
              <div className="p-3">
                <DeskPanel
                  globalPrompt={props.globalPrompt}
                  onGlobalPrompt={props.onGlobalPrompt}
                  onSaveGlobal={props.onSaveGlobal}
                  segmentPrompt={prompt}
                  onSegmentPrompt={props.onPrompt}
                  onSaveSegment={props.onSavePrompt}
                  names={props.characterNames}
                  presets={props.presets}
                  onPresets={props.onPresets}
                />
              </div>
            ) : (
              <div className="p-3">
                <RefBindingPanel
                  picks={props.refPicks}
                  aliasMode={props.aliasMode}
                  prompt={prompt}
                  available={props.availableRefAssets}
                  onAdd={props.onAddRef}
                  onRemove={props.onRemoveRef}
                  onToggleAlias={props.onToggleAlias}
                  onBind={props.onBindRef}
                  onUnbind={props.onUnbindRef}
                />
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ============ 时间轴：全片总览 + 段块轨道 + 刻度 ============ */}
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
          <Clapperboard size={13} className="text-accent-400" />
          <span className="text-[11px] font-medium text-slate-300">全片总览</span>
          <span className="text-[10px] text-slate-600">{shots.length} 段</span>
          <span className="ml-auto text-[10px] text-slate-600">
            橙「续」= 接上一段 · 绿✓ = 已生成 · 点段块切换编辑
          </span>
        </div>
        <div className="px-3 py-2.5">
          {shots.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-black/30 py-8 text-center text-[11px] text-slate-600">
              还没有分段 —— 请先在「剧本与分镜」里添加分镜
            </div>
          ) : (
            <div className="flex gap-1 overflow-x-auto pb-1">
              {shots.map((s, i) => {
                const o = outputOf(s)
                const seg = s.segment
                const active = s.id === curShot?.id
                const frames = seg?.frames ?? 100
                return (
                  <button
                    key={s.id}
                    onClick={() => pick(s)}
                    className={`relative flex h-[64px] min-w-[92px] shrink-0 flex-col overflow-hidden rounded border text-left transition-colors ${
                      active ? 'border-accent-500 bg-accent-600/10 ring-1 ring-accent-500/30' : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                    }`}
                    style={{ flexGrow: frames }}
                    title={`第 ${i + 1} 段 · ${frames} 帧${seg && seg.contMode !== 'none' ? ' · 续接' : ''}`}
                  >
                    <div className="relative h-[42px] w-full bg-black">
                      {o ? (
                        o.kind === 'video' ? (
                          <VideoThumb src={o.file} className="h-full w-full object-cover" />
                        ) : (
                          <MediaImage src={o.file} alt="" className="h-full w-full object-cover" fallback={<div className="h-full w-full" />} />
                        )
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[9px] text-slate-600">待生成</div>
                      )}
                      <span className={`absolute left-1 top-0.5 rounded px-1 text-[9px] ${active ? 'bg-accent-600 text-white' : 'bg-black/70 text-white'}`}>第{i + 1}段</span>
                      {seg && seg.contMode !== 'none' && (
                        <span className="absolute right-1 top-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-medium text-black">续</span>
                      )}
                      {o && (
                        <span className="absolute bottom-0.5 right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500/85 text-black"><Check size={9} strokeWidth={3} /></span>
                      )}
                    </div>
                    <div className="px-1.5 py-0.5 text-[9px] text-slate-500">
                      {seg ? `${seg.durationSec}s · ${frames}帧` : '—'}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          {/* 刻度尺 + 音轨锁（视觉对齐参考图） */}
          <div className="mt-1.5 flex items-center border-t border-white/5 pt-1.5">
            <div className="flex flex-1 items-end gap-0 overflow-hidden">
              {Array.from({ length: 12 }).map((_, i) => (
                <span key={i} className="flex-1 border-l border-white/10 pl-0.5 text-[9px] leading-none text-slate-700">
                  {i === 0 ? '0:00' : ''}
                </span>
              ))}
            </div>
            <span className="ml-2 shrink-0 text-[9px] text-slate-700">音轨锁</span>
          </div>
        </div>
      </section>
    </div>
  )
}
