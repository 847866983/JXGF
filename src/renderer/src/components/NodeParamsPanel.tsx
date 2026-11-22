import { useState } from 'react'
import {
  Activity, ChevronDown, ChevronRight, Cpu, Eye, Gauge, Layers3, RotateCcw,
  SlidersHorizontal, Video, WandSparkles, Zap
} from 'lucide-react'
import type { NodeParams } from '@shared/types'
import {
  MEM_PRESETS, BLOCK_SIZES, SELFLIFT_MEMORY_MODES, SELFLIFT_TILINGS,
  VIDEO_FORMATS, RTX_SCALE_MODES, RTX_QUALITY_LEVELS, RTX_PRECISIONS,
  UPSCALE_TIME_CHUNKS, withNodeParamsDefaults
} from '@shared/node-params'
import { Modal } from './Modal'

/**
 * 节点级参数面板 —— 把 ComfyUI 网页端 节点包节点的 widget 搬进软件。
 *
 * 覆盖：稀疏注意力(SLA) / 显存优化 / SelfLift / Sigma / 预览 / 视频合成 /
 *       RTX 超分 / 显存守卫 / LoRA 多挂载 / 放大时间分块。
 * 改动值写回 Episode.nodeParams，提交时由 applyNodeParams 探测式注入工作流。
 * 只写与出厂默认不同的值，未改动的字段保留 template-adapt 的显存自动适配。
 */

type SectionKey = 'sla' | 'mem' | 'selfLift' | 'sigma' | 'preview' | 'video' | 'rtx' | 'vram' | 'lora' | 'upscale'

interface Section {
  key: SectionKey
  label: string
  icon: React.ReactNode
  hint: string
}

const SECTIONS: Section[] = [
  { key: 'sla', label: '稀疏注意力 SLA', icon: <Zap size={13} />, hint: '跳过后段部分注意力计算，提速；崩坏时关掉' },
  { key: 'mem', label: 'H3 显存优化', icon: <Cpu size={13} />, hint: '前馈分块 / 注意力头分组' },
  { key: 'selfLift', label: 'SelfLift 多级放大', icon: <Layers3 size={13} />, hint: '分段步数 / 级间倍率 / token 分块' },
  { key: 'sigma', label: 'Sigma 位移', icon: <Activity size={13} />, hint: '视频 / 音频噪声调度位移' },
  { key: 'preview', label: '预览覆盖', icon: <Eye size={13} />, hint: '生成过程中的预览分辨率 / 帧率 / 画质' },
  { key: 'video', label: '视频合成输出', icon: <Video size={13} />, hint: '帧率 / 封装格式 / 提示音 / 出片净化' },
  { key: 'rtx', label: 'RTX 超分', icon: <WandSparkles size={13} />, hint: '需要显卡支持；超分阶段开启时生效' },
  { key: 'vram', label: '显存守卫 / 净化', icon: <Gauge size={13} />, hint: '预留容量 / 出片后卸载模型' },
  { key: 'lora', label: 'LoRA 多挂载', icon: <SlidersHorizontal size={13} />, hint: '一次挂载多个 LoRA（H3 主链路）' },
  { key: 'upscale', label: '放大时间分块', icon: <Layers3 size={13} />, hint: '预显影步数 / 强度 / 时间分块' }
]

export interface NodeParamsPanelProps {
  initial: NodeParams | undefined
  loraFiles: string[]
  onSave: (np: NodeParams) => void
  onClose: () => void
}

export default function NodeParamsPanel({ initial, loraFiles, onSave, onClose }: NodeParamsPanelProps): React.JSX.Element {
  const [s, setS] = useState<NodeParams>(() => withNodeParamsDefaults(initial))
  const [open, setOpen] = useState<Set<SectionKey>>(new Set(['sla', 'mem']))

  const toggle = (k: SectionKey): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const num = (v: string, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }

  const fld = (label: string, value: string | number, onChange: (v: string) => void, opts?: {
    type?: string; step?: number; min?: number; max?: number; hint?: string
  }): React.JSX.Element => (
    <div title={opts?.hint}>
      <label className="label">{label}</label>
      <input
        className="field"
        type={opts?.type ?? 'text'}
        step={opts?.step}
        min={opts?.min}
        max={opts?.max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )

  const sel = (label: string, value: string, options: readonly string[], onChange: (v: string) => void, hint?: string): React.JSX.Element => (
    <div title={hint}>
      <label className="label">{label}</label>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )

  const toggleBtn = (label: string, on: boolean, onChange: (v: boolean) => void, hint?: string): React.JSX.Element => (
    <button
      type="button"
      title={hint}
      onClick={() => onChange(!on)}
      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs transition-colors ${
        on ? 'border-accent-500 bg-accent-600/20 text-accent-200' : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
      }`}
    >
      <span>{label}</span>
      <span className={`relative h-4 w-7 shrink-0 rounded-full ${on ? 'bg-accent-500' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
      </span>
    </button>
  )

  const patch = <K extends keyof NodeParams>(k: K, v: NodeParams[K]): void => setS((p) => ({ ...p, [k]: v }))

  return (
    <Modal
      title="节点级参数"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => setS(withNodeParamsDefaults(undefined))} title="恢复所有出厂默认值">
            <RotateCcw size={13} className="mr-1 inline" />恢复默认
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => onSave(s)}>保存节点参数</button>
        </>
      }
    >
      <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
        这些参数直接对应 ComfyUI 工作流里的 节点包节点。<b>只保存你改过的项</b>——没改的字段继续跟随机显存自动适配。
        不确定含义的项保持默认即可。
      </div>

      <div className="space-y-2">
        {SECTIONS.map((sec) => {
          const isOpen = open.has(sec.key)
          return (
            <section key={sec.key} className="rounded-lg border border-white/10 bg-ink-900/60">
              <button
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                onClick={() => toggle(sec.key)}
              >
                {isOpen ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                <span className="text-accent-400">{sec.icon}</span>
                <span className="text-xs font-medium text-slate-200">{sec.label}</span>
                <span className="ml-auto text-[10px] text-slate-500">{sec.hint}</span>
              </button>
              {isOpen && (
                <div className="border-t border-white/5 px-3 py-3">
                  {sec.key === 'sla' && s.sla && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-3">{toggleBtn('启用稀疏注意力', s.sla.enabled, (v) => patch('sla', { ...s.sla!, enabled: v }), '关闭后省多少计算写 0')}</div>
                      {fld('省多少计算 0–95', s.sla.saveCompute, (v) => patch('sla', { ...s.sla!, saveCompute: num(v, 95) }), { type: 'number', min: 0, max: 95, step: 5, hint: '越大越快，细节略降' })}
                      {fld('开头几步不省', s.sla.skipFirstSteps, (v) => patch('sla', { ...s.sla!, skipFirstSteps: num(v, 0) }), { type: 'number', min: 0, max: 8 })}
                      {fld('最后几步精修', s.sla.refineLastSteps, (v) => patch('sla', { ...s.sla!, refineLastSteps: num(v, 0) }), { type: 'number', min: 0, max: 8 })}
                      <div className="col-span-3">{toggleBtn('保住声音', s.sla.keepAudio, (v) => patch('sla', { ...s.sla!, keepAudio: v }))}</div>
                      {fld('参考声音保多少', s.sla.audioRefKeep, (v) => patch('sla', { ...s.sla!, audioRefKeep: num(v, 0) }), { type: 'number', min: 0, max: 65536, step: 512 })}
                      {sel('计算块大小', s.sla.blockSize, BLOCK_SIZES, (v) => patch('sla', { ...s.sla!, blockSize: v as '64' | '128' }), '低显存可用 64')}
                    </div>
                  )}

                  {sec.key === 'mem' && s.memOpt && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-3">{sel('省显存档位', s.memOpt.preset, MEM_PRESETS, (v) => patch('memOpt', { ...s.memOpt!, preset: v }), '①关最快；③强力最省显存')}</div>
                      {fld('前馈分块', s.memOpt.feedforwardChunk, (v) => patch('memOpt', { ...s.memOpt!, feedforwardChunk: num(v, 1) }), { type: 'number', min: 1, max: 64 })}
                      {fld('分块触发长度', s.memOpt.chunkThreshold, (v) => patch('memOpt', { ...s.memOpt!, chunkThreshold: num(v, 4096) }), { type: 'number', min: 256, max: 262144, step: 256 })}
                      {fld('注意力头分组', s.memOpt.headGroup, (v) => patch('memOpt', { ...s.memOpt!, headGroup: num(v, 1) }), { type: 'number', min: 1, max: 56 })}
                    </div>
                  )}

                  {sec.key === 'selfLift' && s.selfLift && (
                    <div className="grid grid-cols-4 gap-2">
                      {fld('分段步数（如 3,3）', s.selfLift.steps, (v) => patch('selfLift', { ...s.selfLift!, steps: v }))}
                      {fld('级间倍率（如 1.5）', s.selfLift.scale, (v) => patch('selfLift', { ...s.selfLift!, scale: v }))}
                      {fld('latent 放大模型', s.selfLift.model, (v) => patch('selfLift', { ...s.selfLift!, model: v }))}
                      {sel('满分辨率分块', s.selfLift.tiling, SELFLIFT_TILINGS, (v) => patch('selfLift', { ...s.selfLift!, tiling: v }))}
                      {fld('彩色光点清理力度', s.selfLift.cleanup, (v) => patch('selfLift', { ...s.selfLift!, cleanup: num(v, 9) }), { type: 'number', min: 6, max: 12, step: 0.5 })}
                      {sel('省显存模式', s.selfLift.memMode, SELFLIFT_MEMORY_MODES, (v) => patch('selfLift', { ...s.selfLift!, memMode: v }))}
                      {fld('token 分块大小', s.selfLift.tokenChunk, (v) => patch('selfLift', { ...s.selfLift!, tokenChunk: num(v, 4096) }), { type: 'number', min: 128, max: 16384, step: 128 })}
                      {fld('权重缓存预算', s.selfLift.weightCache, (v) => patch('selfLift', { ...s.selfLift!, weightCache: num(v, 4) }), { type: 'number', min: 0, max: 64, step: 0.5 })}
                    </div>
                  )}

                  {sec.key === 'sigma' && s.sigma && (
                    <div className="grid grid-cols-2 gap-2">
                      {fld('shift_video', s.sigma.shiftVideo, (v) => patch('sigma', { ...s.sigma!, shiftVideo: num(v, 12) }), { type: 'number', step: 0.1, hint: '视频噪声调度位移，默认 12' })}
                      {fld('shift_audio', s.sigma.shiftAudio, (v) => patch('sigma', { ...s.sigma!, shiftAudio: num(v, 3) }), { type: 'number', step: 0.1, hint: '音频噪声调度位移，默认 3' })}
                    </div>
                  )}

                  {sec.key === 'preview' && s.preview && (
                    <div className="grid grid-cols-3 gap-2">
                      {fld('最大分辨率', s.preview.maxResolution, (v) => patch('preview', { ...s.preview!, maxResolution: num(v, 960) }), { type: 'number', step: 8 })}
                      {fld('预览画质', s.preview.jpegQuality, (v) => patch('preview', { ...s.preview!, jpegQuality: num(v, 80) }), { type: 'number', min: 30, max: 100 })}
                      <div>{toggleBtn('抑制默认预览', s.preview.suppressDefault, (v) => patch('preview', { ...s.preview!, suppressDefault: v }))}</div>
                      {fld('预览帧数', s.preview.previewFrames, (v) => patch('preview', { ...s.preview!, previewFrames: num(v, 60) }), { type: 'number', min: 1, max: 1024 })}
                      {fld('预览帧率', s.preview.previewFps, (v) => patch('preview', { ...s.preview!, previewFps: num(v, 4) }), { type: 'number', min: 1, max: 60 })}
                      {fld('预览 VAE 文件', s.preview.vaeName, (v) => patch('preview', { ...s.preview!, vaeName: v }))}
                    </div>
                  )}

                  {sec.key === 'video' && s.videoCombine && (
                    <div className="grid grid-cols-3 gap-2">
                      {fld('帧率', s.videoCombine.fps, (v) => patch('videoCombine', { ...s.videoCombine!, fps: num(v, 24) }), { type: 'number', step: 0.01 })}
                      {sel('视频格式', s.videoCombine.format, VIDEO_FORMATS, (v) => patch('videoCombine', { ...s.videoCombine!, format: v }))}
                      <div>{toggleBtn('保存元数据', s.videoCombine.saveMetadata, (v) => patch('videoCombine', { ...s.videoCombine!, saveMetadata: v }))}</div>
                      {fld('提示音文件', s.videoCombine.notifyFile, (v) => patch('videoCombine', { ...s.videoCombine!, notifyFile: v }))}
                      <div>{toggleBtn('出片后净化', s.videoCombine.cleanAfter, (v) => patch('videoCombine', { ...s.videoCombine!, cleanAfter: v }), '出片后卸载模型清缓存')}</div>
                      {fld('自定义保存路径', s.videoCombine.customPath, (v) => patch('videoCombine', { ...s.videoCombine!, customPath: v }))}
                    </div>
                  )}

                  {sec.key === 'rtx' && s.rtx && (
                    <div className="grid grid-cols-4 gap-2">
                      {sel('缩放方式', s.rtx.scaleMode, RTX_SCALE_MODES, (v) => patch('rtx', { ...s.rtx!, scaleMode: v }))}
                      {fld('放大倍数', s.rtx.scale, (v) => patch('rtx', { ...s.rtx!, scale: num(v, 2) }), { type: 'number', step: 0.01, min: 1, max: 4 })}
                      {fld('输出宽度', s.rtx.width, (v) => patch('rtx', { ...s.rtx!, width: num(v, 1920) }), { type: 'number', step: 8 })}
                      {fld('输出高度', s.rtx.height, (v) => patch('rtx', { ...s.rtx!, height: num(v, 1080) }), { type: 'number', step: 8 })}
                      <div className="col-span-2">{sel('处理档位', s.rtx.preset, RTX_QUALITY_LEVELS, (v) => patch('rtx', { ...s.rtx!, preset: v }))}</div>
                      {fld('强度', s.rtx.strength, (v) => patch('rtx', { ...s.rtx!, strength: num(v, 1) }), { type: 'number', step: 0.01, min: 0, max: 1 })}
                      {sel('像素精度', s.rtx.precision, RTX_PRECISIONS, (v) => patch('rtx', { ...s.rtx!, precision: v }))}
                      {fld('序列源帧率', s.rtx.fps, (v) => patch('rtx', { ...s.rtx!, fps: num(v, 24) }), { type: 'number', min: 1, max: 240 })}
                      <div>{toggleBtn('封装视频', s.rtx.packVideo, (v) => patch('rtx', { ...s.rtx!, packVideo: v }))}</div>
                      <div>{toggleBtn('保留原音', s.rtx.keepAudio, (v) => patch('rtx', { ...s.rtx!, keepAudio: v }))}</div>
                    </div>
                  )}

                  {sec.key === 'vram' && s.vram && (
                    <div className="grid grid-cols-3 gap-2">
                      {fld('预留容量 GB', s.vram.guardGB, (v) => patch('vram', { ...s.vram!, guardGB: num(v, 0.2) }), { type: 'number', step: 0.1, hint: '越大越安全，越小越快' })}
                      <div>{toggleBtn('卸载模型', s.vram.cleanerUnload, (v) => patch('vram', { ...s.vram!, cleanerUnload: v }))}</div>
                      <div>{toggleBtn('清理缓存', s.vram.cleanerCache, (v) => patch('vram', { ...s.vram!, cleanerCache: v }))}</div>
                    </div>
                  )}

                  {sec.key === 'lora' && (
                    <div className="space-y-2">
                      {(s.loraSlots ?? []).map((row, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                          <input
                            type="checkbox"
                            className="accent-[#7c5cff]"
                            checked={row.on !== false}
                            onChange={(e) => {
                              const rows = [...(s.loraSlots ?? [])]
                              rows[i] = { ...rows[i], on: e.target.checked }
                              patch('loraSlots', rows)
                            }}
                          />
                          <input
                            className="field min-w-0 flex-1"
                            list={`nodeparams-lora-${i}`}
                            placeholder="LoRA 文件名（含子目录，如 MiniMax-H3/xxx.safetensors）"
                            value={row.file}
                            onChange={(e) => {
                              const rows = [...(s.loraSlots ?? [])]
                              rows[i] = { ...rows[i], file: e.target.value }
                              patch('loraSlots', rows)
                            }}
                          />
                          <datalist id={`nodeparams-lora-${i}`}>
                            {loraFiles.map((f) => <option key={f} value={f} />)}
                          </datalist>
                          <input
                            className="field w-20"
                            type="number"
                            step={0.05}
                            title="强度"
                            value={row.strength}
                            onChange={(e) => {
                              const rows = [...(s.loraSlots ?? [])]
                              rows[i] = { ...rows[i], strength: num(e.target.value, 1) }
                              patch('loraSlots', rows)
                            }}
                          />
                          <button
                            className="text-slate-500 hover:text-rose-400"
                            title="移除该行"
                            onClick={() => patch('loraSlots', (s.loraSlots ?? []).filter((_, j) => j !== i))}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        className="btn-ghost w-full text-xs"
                        onClick={() => patch('loraSlots', [...(s.loraSlots ?? []), { on: true, file: '', strength: 1, note: '' }])}
                      >
                        + 添加一行 LoRA
                      </button>
                    </div>
                  )}

                  {sec.key === 'upscale' && (
                    <div className="grid grid-cols-3 gap-2">
                      {sel('放大时间分块', s.upscaleTimeChunk ?? '自动（按显存）', UPSCALE_TIME_CHUNKS, (v) => patch('upscaleTimeChunk', v))}
                      {fld('预显影步数', s.preDecodeSteps ?? 0, (v) => patch('preDecodeSteps', num(v, 0)), { type: 'number', min: 0, max: 8 })}
                      {fld('预显影强度', s.preDecodeStrength ?? 0.05, (v) => patch('preDecodeStrength', num(v, 0.05)), { type: 'number', step: 0.05, min: 0.05, max: 0.95 })}
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
