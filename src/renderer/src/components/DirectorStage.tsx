import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Layers, Play, SlidersHorizontal, Wand2 } from 'lucide-react'
import type { SegmentSettings, Shot } from '@shared/types'
import { MediaImage } from '../components/MediaImage'
import { PromptEditor } from './PromptEditor'
import { VideoThumb } from '../components/VideoThumb'

/**
 * 导演台主界面（20261120 改版）
 *
 * 布局按用户指定：
 *   左上：集数 + 分镜信息
 *   右上：大屏预览
 *   左上还含：本段提示词（自动保存）+ 续接开关
 *   底部：分段预览（时间轴，一横排，全宽）
 *   最下：渲染所有分段
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
  onOpenParams: () => void
  /** 当前段引用的资产名（提示词里出现即高亮） */
  characterNames: string[]
  /** 当前段是否正在提交 */
  submitting: boolean
}

function outputOf(shot: Shot | null): { file: string; kind: string } | null {
  if (!shot || shot.outputs.length === 0) return null
  const kept = shot.outputs.find((o) => o.kept !== false)
  const last = shot.outputs[shot.outputs.length - 1]
  const pick = kept ?? last
  return pick ? { file: pick.file, kind: pick.kind } : null
}

export default function DirectorStage(props: DirectorStageProps): React.JSX.Element {
  const { shots, curShot, curSeg, prompt } = props

  // 提示词自动保存（停顿 1.2 秒）；失焦时也会立刻保存，所以「切走 = 已保存」
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
    if (!shot) return
    props.onSelect(shot.id)
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-4">
      {/* ============ 左列 ============ */}
      <div className="flex min-w-0 flex-col gap-3">
        {/* 左上：集数 + 分镜信息 */}
        <section className="panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <Layers size={14} className="text-accent-400" />
            <span className="text-xs font-medium text-white">剧集与分镜</span>
            <span className="ml-auto text-[10px] text-slate-500">
              {shots.length} 段 · 待生成 {props.pendingCount}
            </span>
          </div>
          <select
            className="field mb-2 w-full text-xs"
            value={props.episodeId}
            onChange={(e) => props.onEpisode(e.target.value)}
          >
            {props.episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.title}
              </option>
            ))}
          </select>

          {curShot ? (
            <div className="space-y-1 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="rounded bg-accent-600/20 px-1.5 py-0.5 text-accent-300">
                  第 {curIndex + 1} 段
                </span>
                <span className="truncate font-medium text-slate-200">{curShot.title}</span>
              </div>
              <div className="line-clamp-2 text-slate-400">{curShot.description || '（无描述）'}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
                {curShot.dialogue && <span>台词：{curShot.dialogue}</span>}
                {curShot.camera && <span>镜头：{curShot.camera}</span>}
                {curShot.duration ? <span>时长：{curShot.duration}s</span> : null}
              </div>
              {curSeg && (
                <div className="flex flex-wrap gap-1 pt-1 text-[10px] text-slate-500">
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5">
                    {curSeg.width}×{curSeg.height}
                  </span>
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5">{curSeg.frames} 帧</span>
                  <span className="rounded bg-white/[0.05] px-1.5 py-0.5">
                    {curSeg.contMode === 'none' ? '不续接' : '潜空间续接'}
                  </span>
                  <button
                    className="rounded bg-white/[0.05] px-1.5 py-0.5 text-slate-400 hover:text-slate-200"
                    onClick={props.onOpenParams}
                  >
                    <SlidersHorizontal size={10} className="mr-0.5 inline" />
                    全部参数
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-slate-500">这个剧集还没有分镜</div>
          )}
        {/* 续接开关：直接当按钮点，高亮=接上一段 */}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => props.onPatch({ contMode: curSeg?.contMode === 'none' ? 'latent' : 'none' })}
            disabled={!curShot}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              curSeg && curSeg.contMode !== 'none'
                ? 'border-accent-500 bg-accent-600/25 text-accent-200'
                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
            }`}
          >
            {curSeg && curSeg.contMode !== 'none' ? '● 续接上一段（开）' : '○ 不续接（关）'}
          </button>
          {curSeg && curSeg.contMode !== 'none' && (
            <input
              className="field w-20 text-xs"
              type="number"
              min={0}
              step={17}
              value={curSeg.contFrames ?? 22}
              onChange={(e) => props.onPatch({ contFrames: Math.max(0, Number(e.target.value) || 0) })}
              title="承接帧数（5/22/39/56/73…）"
            />
          )}
        </div>

        {/* 提示词：直接在页面上改，失焦/停顿 1 秒自动保存，无需点保存 */}
        <div className="mt-2 flex-1">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[10px] text-slate-500">本段提示词（自动保存）</label>
            <button
              className="text-[10px] text-slate-500 hover:text-slate-300"
              onClick={props.onOpenParams}
            >
              更多参数
            </button>
          </div>
          <PromptEditor
            value={prompt}
            onChange={props.onPrompt}
            onBlur={props.onSavePrompt}
            names={props.characterNames}
            placeholder="描述这一段的画面、人物动作、镜头运动与声音…（写 @图片1 或角色名会高亮）"
            minHeight={150}
          />
        </div>
        </section>

      </div>

      {/* ============ 右上：大预览 ============ */}
      <section className="panel flex min-w-0 flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-white">
            预览 · 第 {curIndex + 1} 段
          </span>
          <div className="flex items-center gap-1">
            <button
              className="rounded p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30"
              disabled={!prev}
              onClick={() => props.onSelect(prev!.id)}
              title="上一段"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              className="rounded p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30"
              disabled={!next}
              onClick={() => props.onSelect(next!.id)}
              title="下一段"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="relative flex-1 overflow-hidden rounded-lg bg-black" style={{ minHeight: 360 }}>
          {out ? (
            out.kind === 'video' ? (
              <VideoThumb src={out.file} className="h-full w-full object-contain" />
            ) : (
              <MediaImage src={out.file} alt="" className="h-full w-full object-contain" fallback={<div className="h-full w-full" />} />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              这一段还没有成片 —— 点左下角分段修改提示词后生成本段
            </div>
          )}
        </div>


        <button
          className="btn-primary mt-2 w-full"
          disabled={!curShot || props.submitting}
          onClick={props.onGenerateOne}
        >
          <Wand2 size={14} />
          {props.submitting ? '提交中…' : '生成本段'}
        </button>
      </section>

        {/* 底部：分段预览（时间轴，一横排，全宽） */}
        <section className="panel col-span-2 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-white">分段预览</span>
            <span className="text-[10px] text-slate-500">点任意一段 → 修改提示词</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {shots.map((s, i) => {
              const o = outputOf(s)
              const seg = s.segment
              const active = s.id === curShot?.id
              return (
                <button
                  key={s.id}
                  onClick={() => pick(s)}
                  className={`group relative w-[132px] shrink-0 overflow-hidden rounded-lg border text-left transition-colors ${
                    active ? 'border-accent-500 bg-accent-600/10' : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                  }`}
                >
                  <div className="relative h-[74px] w-full bg-black">
                    {o ? (
                      o.kind === 'video' ? (
                        <VideoThumb src={o.file} className="h-full w-full object-cover" />
                      ) : (
                        <MediaImage src={o.file} alt="" className="h-full w-full object-cover" fallback={<div className="h-full w-full" />} />
                      )
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">待生成</div>
                    )}
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] text-white">第{i + 1}段</span>
                    {seg?.contMode && seg.contMode !== 'none' && (
                      <span className="absolute right-1 top-1 rounded bg-amber-500/80 px-1 text-[9px] text-black">续</span>
                    )}
                  </div>
                  <div className="px-1.5 py-1 text-[9px] text-slate-500">
                    {seg ? `${seg.durationSec}s · ${seg.frames}帧` : '—'}
                  </div>
                </button>
              )
            })}
          </div>
        </section>

      {/* ============ 最下：渲染所有分段 ============ */}
      <div className="col-span-2">
        <button
          className="btn-primary w-full"
          disabled={!props.canGenerate || props.batchRunning || props.pendingCount === 0}
          onClick={props.onGenerateAll}
        >
          <Play size={15} />
          {props.batchRunning ? '全部渲染中…' : `渲染所有分段（${props.pendingCount} 段待生成）`}
        </button>
      </div>
    </div>
  )
}
