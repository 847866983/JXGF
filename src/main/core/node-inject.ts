/**
 * 工作流节点包 B 类节点参数注入。
 *
 * 把 Episode.nodeParams（用户在「节点级参数」面板里配的值）写进 API 工作流，
 * 按 class_type **探测式**定位节点，不写死节点 ID —— 换模板/改连线照样生效。
 *
 * 关键设计：只写「与出厂默认不同」的值。
 *   · 用户没碰过的字段 = 默认值 → 跳过 → 保留 template-adapt 的显存自动适配结果；
 *   · 用户改过的字段 → 写入 → 手动值覆盖自动适配。
 * 每次生成都从干净的模板 clone 开始，所以「把值改回默认」也能正确恢复。
 *
 * 字段名逐字对齐 工作流节点包 的 INPUT_TYPES（见 shared/node-params.ts 注释）。
 */
import type { NodeParams } from '@shared/types'
import {
  defaultNodeParams,
  defaultSla,
  defaultMemOpt,
  defaultSelfLift,
  defaultSigma,
  defaultPreview,
  defaultVideoCombine,
  defaultRtx,
  defaultVram
} from '../../shared/node-params.ts'

type WfNode = { class_type: string; inputs: Record<string, unknown> }
type Workflow = Record<string, WfNode>

/** 仅当 value 与出厂默认不同时才写入 inputs —— 让显存自动适配保留生效 */
function setChanged(inputs: Record<string, unknown>, key: string, value: unknown, fallback: unknown): void {
  if (value === undefined || value === null) return
  if (Object.is(value, fallback)) return
  inputs[key] = value
}

/**
 * 把节点参数注入工作流。原地修改 clone。
 * @returns 命中的节点数量（用于自检 / 日志）
 */
export function applyNodeParams(clone: unknown, params: NodeParams | undefined): number {
  if (!params || !clone || typeof clone !== 'object' || Array.isArray(clone)) return 0
  const wf = clone as Workflow
  let hits = 0

  for (const node of Object.values(wf)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.inputs !== 'object') continue
    const ct = String(node.class_type ?? '')
    const i = node.inputs

    // ---- 稀疏注意力 ----
    if (ct === 'BanZhang_SLABlockSparseAttention' && params.sla) {
      const p = params.sla
      const d = defaultSla
      // 关闭必须强制写 0（即便等于 fallback），否则模板残留的 95 会继续减计算
      if (!p.enabled) i['省多少计算'] = 0
      else setChanged(i, '省多少计算', p.saveCompute, d.saveCompute)
      setChanged(i, '开头几步不省', p.skipFirstSteps, d.skipFirstSteps)
      setChanged(i, '最后几步精修', p.refineLastSteps, d.refineLastSteps)
      setChanged(i, '保住声音', p.keepAudio, d.keepAudio)
      setChanged(i, '参考声音保多少', p.audioRefKeep, d.audioRefKeep)
      setChanged(i, '计算块大小', p.blockSize, d.blockSize)
      hits++
    }

    // ---- H3 显存优化 ----
    else if (ct === 'BanZhang_H3MemoryOptimizer' && params.memOpt) {
      const p = params.memOpt
      const d = defaultMemOpt
      setChanged(i, '省显存档位', p.preset, d.preset)
      setChanged(i, '前馈分块', p.feedforwardChunk, d.feedforwardChunk)
      setChanged(i, '分块触发长度', p.chunkThreshold, d.chunkThreshold)
      setChanged(i, '注意力头分组', p.headGroup, d.headGroup)
      hits++
    }

    // ---- SelfLift 多级放大 ----
    else if (ct === 'BanZhang_SelfLiftMultiStage' && params.selfLift) {
      const p = params.selfLift
      const d = defaultSelfLift
      setChanged(i, '分段步数', p.steps, d.steps)
      setChanged(i, '级间倍率', p.scale, d.scale)
      if (p.model) setChanged(i, 'latent放大模型', p.model, d.model)
      setChanged(i, '满分辨率分块', p.tiling, d.tiling)
      setChanged(i, '彩色光点清理力度', p.cleanup, d.cleanup)
      setChanged(i, '省显存模式', p.memMode, d.memMode)
      setChanged(i, 'token分块大小', p.tokenChunk, d.tokenChunk)
      setChanged(i, '权重缓存预算', p.weightCache, d.weightCache)
      hits++
    }

    // ---- Sigma 位移（ComfyUI 核心 V3 节点，英文下划线字段）----
    else if (ct === 'MiniMaxH3SigmaShift' && params.sigma) {
      const p = params.sigma
      const d = defaultSigma
      setChanged(i, 'shift_video', p.shiftVideo, d.shiftVideo)
      setChanged(i, 'shift_audio', p.shiftAudio, d.shiftAudio)
      hits++
    }

    // ---- 预览覆盖（V3 节点，英文下划线字段）----
    else if (ct === 'MiniMaxH3PreviewOverride' && params.preview) {
      const p = params.preview
      const d = defaultPreview
      setChanged(i, 'max_resolution', p.maxResolution, d.maxResolution)
      setChanged(i, 'jpeg_quality', p.jpegQuality, d.jpegQuality)
      setChanged(i, 'suppress_default_preview', p.suppressDefault, d.suppressDefault)
      setChanged(i, 'preview_frames', p.previewFrames, d.previewFrames)
      setChanged(i, 'preview_fps', p.previewFps, d.previewFps)
      if (p.vaeName) setChanged(i, 'vae_name', p.vaeName, d.vaeName)
      hits++
    }

    // ---- 视频合成（4 个输出节点共用一份配置；不碰文件前缀——它是产物挑选的依据）----
    else if (ct === 'banzhangVideoCombine' && params.videoCombine) {
      const p = params.videoCombine
      const d = defaultVideoCombine
      setChanged(i, '⏱️ 帧率', p.fps, d.fps)
      setChanged(i, '📼 视频格式', p.format, d.format)
      setChanged(i, '💾 保存元数据', p.saveMetadata, d.saveMetadata)
      setChanged(i, '🔔 提示音文件', p.notifyFile, d.notifyFile)
      setChanged(i, '🧹 出片后自动净化', p.cleanAfter, d.cleanAfter)
      if (p.customPath) setChanged(i, '📂 自定义保存路径', p.customPath, d.customPath)
      hits++
    }

    // ---- RTX 超分 ----
    else if (ct === 'BanZhang_RTX_SuperResolution' && params.rtx) {
      const p = params.rtx
      const d = defaultRtx
      setChanged(i, '缩放方式', p.scaleMode, d.scaleMode)
      setChanged(i, '放大倍数', p.scale, d.scale)
      setChanged(i, '输出宽度', p.width, d.width)
      setChanged(i, '输出高度', p.height, d.height)
      setChanged(i, '处理档位', p.preset, d.preset)
      setChanged(i, '强度', p.strength, d.strength)
      setChanged(i, '像素精度', p.precision, d.precision)
      setChanged(i, '序列源帧率', p.fps, d.fps)
      setChanged(i, '封装视频', p.packVideo ? '开' : '关', '开')
      setChanged(i, '保留原音', p.keepAudio ? '开' : '关', '开')
      hits++
    }

    // ---- 显存守卫 / 净化 ----
    else if (ct === 'BanZhang_VRAM_Guard' && params.vram) {
      setChanged(i, '预留容量_GB', params.vram.guardGB, defaultVram.guardGB)
      hits++
    } else if (ct === 'BanZhang_VRAM_Cleaner' && params.vram) {
      setChanged(i, '卸载模型', params.vram.cleanerUnload, defaultVram.cleanerUnload)
      setChanged(i, '清理缓存', params.vram.cleanerCache, defaultVram.cleanerCache)
      hits++
    }

    // ---- LoRA 多挂载面板（前端 JS 改名 lora面板，API 字段用 LoRA配置）----
    else if (ct === 'BanZhang_LoRA_VramSafe' && Array.isArray(params.loraSlots) && params.loraSlots.length > 0) {
      const rows = params.loraSlots.map((s) => ({
        on: s.on !== false,
        file: String(s.file ?? '').replace(/\\/g, '/'),
        strength: Number(s.strength ?? 1),
        note: String(s.note ?? '')
      }))
      i['LoRA配置'] = JSON.stringify(rows)
      // 单 LoRA 兜底字段同步到第一个启用项，避免面板为空时节点回退到错误 LoRA
      const first = rows.find((r) => r.on && r.file)
      if (first) {
        i['LoRA文件'] = first.file
        i['模型强度'] = String(first.strength)
      }
      hits++
    }

    // ---- 放大参数节点：时间分块 / 预显影 ----
    else if (ct === 'BanZhang_MMH3_UpscaleParams') {
      let touched = false
      if (params.upscaleTimeChunk !== undefined && params.upscaleTimeChunk !== defaultNodeParams.upscaleTimeChunk) {
        i['放大时间分块'] = params.upscaleTimeChunk
        touched = true
      }
      if (params.preDecodeSteps !== undefined && params.preDecodeSteps !== defaultNodeParams.preDecodeSteps) {
        i['预显影步数'] = params.preDecodeSteps
        touched = true
      }
      if (params.preDecodeStrength !== undefined && params.preDecodeStrength !== defaultNodeParams.preDecodeStrength) {
        i['预显影强度'] = params.preDecodeStrength
        touched = true
      }
      if (touched) hits++
    }
  }

  return hits
}

/** 从工作流里读出当前各节点的实际参数值（回填 UI 表单用）。只读，不改。 */
export function readNodeParams(clone: unknown): Partial<NodeParams> {
  const out: Partial<NodeParams> = {}
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) return out
  const wf = clone as Workflow
  const num = (v: unknown, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)

  for (const node of Object.values(wf)) {
    if (!node?.inputs) continue
    const ct = String(node.class_type ?? '')
    const i = node.inputs
    if (ct === 'BanZhang_SLABlockSparseAttention') {
      const saveCompute = num(i['省多少计算'], defaultSla.saveCompute)
      out.sla = {
        enabled: saveCompute > 0,
        saveCompute,
        skipFirstSteps: num(i['开头几步不省'], defaultSla.skipFirstSteps),
        refineLastSteps: num(i['最后几步精修'], defaultSla.refineLastSteps),
        keepAudio: bool(i['保住声音'], defaultSla.keepAudio),
        audioRefKeep: num(i['参考声音保多少'], defaultSla.audioRefKeep),
        blockSize: str(i['计算块大小'], defaultSla.blockSize) === '128' ? '128' : '64'
      }
    } else if (ct === 'BanZhang_H3MemoryOptimizer') {
      out.memOpt = {
        preset: str(i['省显存档位'], defaultMemOpt.preset),
        feedforwardChunk: num(i['前馈分块'], defaultMemOpt.feedforwardChunk),
        chunkThreshold: num(i['分块触发长度'], defaultMemOpt.chunkThreshold),
        headGroup: num(i['注意力头分组'], defaultMemOpt.headGroup)
      }
    } else if (ct === 'BanZhang_SelfLiftMultiStage') {
      out.selfLift = {
        steps: str(i['分段步数'], defaultSelfLift.steps),
        scale: str(i['级间倍率'], defaultSelfLift.scale),
        model: str(i['latent放大模型'], defaultSelfLift.model),
        tiling: str(i['满分辨率分块'], defaultSelfLift.tiling),
        cleanup: num(i['彩色光点清理力度'], defaultSelfLift.cleanup),
        memMode: str(i['省显存模式'], defaultSelfLift.memMode),
        tokenChunk: num(i['token分块大小'], defaultSelfLift.tokenChunk),
        weightCache: num(i['权重缓存预算'], defaultSelfLift.weightCache)
      }
    } else if (ct === 'MiniMaxH3SigmaShift') {
      out.sigma = {
        shiftVideo: num(i.shift_video, defaultSigma.shiftVideo),
        shiftAudio: num(i.shift_audio, defaultSigma.shiftAudio)
      }
    } else if (ct === 'MiniMaxH3PreviewOverride') {
      out.preview = {
        maxResolution: num(i.max_resolution, defaultPreview.maxResolution),
        jpegQuality: num(i.jpeg_quality, defaultPreview.jpegQuality),
        suppressDefault: bool(i.suppress_default_preview, defaultPreview.suppressDefault),
        previewFrames: num(i.preview_frames, defaultPreview.previewFrames),
        previewFps: num(i.preview_fps, defaultPreview.previewFps),
        vaeName: str(i.vae_name, defaultPreview.vaeName)
      }
    } else if (ct === 'banzhangVideoCombine' && !out.videoCombine) {
      out.videoCombine = {
        fps: num(i['⏱️ 帧率'], defaultVideoCombine.fps),
        format: str(i['📼 视频格式'], defaultVideoCombine.format),
        saveMetadata: bool(i['💾 保存元数据'], defaultVideoCombine.saveMetadata),
        notifyFile: str(i['🔔 提示音文件'], defaultVideoCombine.notifyFile),
        cleanAfter: bool(i['🧹 出片后自动净化'], defaultVideoCombine.cleanAfter),
        customPath: str(i['📂 自定义保存路径'], defaultVideoCombine.customPath)
      }
    } else if (ct === 'BanZhang_RTX_SuperResolution') {
      out.rtx = {
        scaleMode: str(i['缩放方式'], defaultRtx.scaleMode),
        scale: num(i['放大倍数'], defaultRtx.scale),
        width: num(i['输出宽度'], defaultRtx.width),
        height: num(i['输出高度'], defaultRtx.height),
        preset: str(i['处理档位'], defaultRtx.preset),
        strength: num(i['强度'], defaultRtx.strength),
        precision: str(i['像素精度'], defaultRtx.precision),
        fps: num(i['序列源帧率'], defaultRtx.fps),
        packVideo: str(i['封装视频'], '开') === '开',
        keepAudio: str(i['保留原音'], '开') === '开'
      }
    } else if (ct === 'BanZhang_VRAM_Guard') {
      out.vram = { ...(out.vram ?? defaultVram), guardGB: num(i['预留容量_GB'], defaultVram.guardGB) }
    } else if (ct === 'BanZhang_VRAM_Cleaner') {
      out.vram = {
        ...(out.vram ?? defaultVram),
        cleanerUnload: bool(i['卸载模型'], defaultVram.cleanerUnload),
        cleanerCache: bool(i['清理缓存'], defaultVram.cleanerCache)
      }
    } else if (ct === 'BanZhang_LoRA_VramSafe' && typeof i['LoRA配置'] === 'string') {
      try {
        const rows = JSON.parse(i['LoRA配置'] as string)
        if (Array.isArray(rows)) out.loraSlots = rows.map((r: Record<string, unknown>) => ({
          on: r.on !== false,
          file: String(r.file ?? ''),
          strength: Number(r.strength ?? 1),
          note: String(r.note ?? '')
        }))
      } catch { /* 配置损坏时忽略 */ }
    } else if (ct === 'BanZhang_MMH3_UpscaleParams' && !out.upscaleTimeChunk) {
      out.upscaleTimeChunk = str(i['放大时间分块'], defaultNodeParams.upscaleTimeChunk ?? '自动（按显存）')
      out.preDecodeSteps = num(i['预显影步数'], defaultNodeParams.preDecodeSteps ?? 0)
      out.preDecodeStrength = num(i['预显影强度'], defaultNodeParams.preDecodeStrength ?? 0.05)
    }
  }
  return out
}
