import path from 'node:path'
import fsp from 'node:fs/promises'
import type { ComfySettings, JobInfo, JobParams, JobStatus, ShotOutput, Template } from '@shared/types'
import { ComfyClient, makeClient } from './comfy'
import { buildWorkflow, extractH3Chain, injectH3RefImages, injectH3RefVideos } from './workflow'
import { uid, now, ProjectStore } from './store'
import { collectMediaFiles, collectHistoryFiles, pickFinalMedia, type MediaFile } from './output-files'

interface QueuedJob {
  info: JobInfo
  params: JobParams
  template: Template
  settings: ComfySettings
  attempt: number
}

type Emit = (type: 'job:updated' | 'job:progress', payload: Record<string, unknown>) => void

/**
 * 任务队列：单一真相所在。UI 只发命令，这里负责
 * 排队 -> 提交 ComfyUI -> WS 进度 -> 取历史 -> 下载归档 -> 回写分镜产物。
 */
type RetryableError = Error & { noRetry?: boolean }

export class JobManager {
  private jobs = new Map<string, JobInfo>()
  private queue: QueuedJob[] = []
  private running = false
  private client: ComfyClient | null = null
  private readonly emit: Emit
  /** 记录每个 jobId 的原始参数，供失败后一键重试 */
  private jobParams = new Map<string, JobParams>()

  constructor(private readonly store: ProjectStore, emit: Emit) {
    this.emit = emit
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  enqueue(params: JobParams): JobInfo {
    const project = this.store.getCurrent()
    if (!project) throw new Error('请先打开一个项目')
    const template = project.templates.find((t) => t.id === params.templateId)
    if (!template) throw new Error('找不到生成模板')
    const info: JobInfo = {
      id: uid('job_'),
      kind: template.kind,
      status: 'queued',
      progress: 0,
      shotId: params.shotId,
      outputs: [],
      createdAt: now()
    }
    this.jobs.set(info.id, info)
    this.jobParams.set(info.id, params)
    this.queue.push({ info, params, template, settings: project.settings.comfy, attempt: 0 })
    this.emit('job:updated', { job: info })
    void this.pump()
    return info
  }

  /** 用原参数重新提交（失败重试） */
  retry(jobId: string): JobInfo {
    const params = this.jobParams.get(jobId)
    if (!params) throw new Error('该任务没有可重试的原始参数（可能已过期）')
    const job = this.jobs.get(jobId)
    if (job) {
      job.status = 'cancelled'
      this.emit('job:updated', { job })
    }
    return this.enqueue(params)
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q.info.id !== jobId)
      job.status = 'cancelled'
      this.emit('job:updated', { job })
    } else if (job.status === 'running') {
      void this.client?.interrupt()
      job.status = 'cancelled'
      this.emit('job:updated', { job })
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) return
    this.running = true
    try {
      await this.runJob(next)
    } finally {
      this.running = false
      if (this.queue.length > 0) void this.pump()
    }
  }

  private async runJob(q: QueuedJob): Promise<void> {
    const { info, params, template, settings } = q
    const project = this.store.getCurrent()
    info.status = 'running'
    info.startedAt = now()
    this.emit('job:updated', { job: info })

    try {
      this.client = makeClient(settings)
      await this.client.connect()
      this.bindClientEvents(this.client)

      const workflow = buildWorkflow(template, {
        positive: params.positive,
        negative: params.negative,
        width: params.width,
        height: params.height,
        frames: params.frames,
        seed: params.seed,
        batch: params.batch,
        steps: params.steps,
        cfg: params.cfg,
        samplerName: params.samplerName,
        scheduler: params.scheduler,
        h3: params.h3,
        upscale: params.upscale,
        rife: params.rife,
        refImages: params.refImages
      })

      // 参考图：分镜引用的资产封面，上传到 ComfyUI 后注入 H3 媒体架（ref2va 素材）。
      const refImages = Array.isArray(params.refImages) ? params.refImages.filter(Boolean) : []
      if (refImages.length > 0) {
        try {
          const uploaded: string[] = []
          for (const localPath of refImages) {
            const up = await this.client.uploadImage(localPath)
            uploaded.push(up.subfolder ? `${up.subfolder}/${up.name}` : up.name)
          }
          injectH3RefImages(workflow, uploaded)
        } catch (err) {
          console.warn('[jobs] 上传参考图失败（不阻断生成）:', String((err as Error).message ?? err))
        }
      }

      // 参考视频：本段生成方式=视频参考时，上传上一段成片并写入媒体架 videos 槽
      const refVideos = Array.isArray(params.refVideos) ? params.refVideos.filter(Boolean) : []
      if (refVideos.length > 0) {
        try {
          const uploaded: string[] = []
          for (const localPath of refVideos) {
            const up = await this.client.uploadImage(localPath)
            uploaded.push(up.subfolder ? `${up.subfolder}/${up.name}` : up.name)
          }
          injectH3RefVideos(workflow, uploaded)
        } catch (err) {
          console.warn('[jobs] 上传参考视频失败（不阻断生成）:', String((err as Error).message ?? err))
        }
      }

      // H3 链式续接：提交前登记工程名 + 当前段，否则存档节点会拒绝。
      // 失败不阻断生成（登记失败时 CSGlideCastCS 自己会兜底登记，只是存档节点可能跳过）。
      const chain = extractH3Chain(workflow)
      if (chain) {
        try {
          await this.client.registerClip(chain.name, { shot: chain.shot, frames: params.frames })
        } catch (err) {
          console.warn('[jobs] 登记段落失败（不阻断生成）:', String((err as Error).message ?? err))
        }
      }

      const promptId = await this.client.submit(workflow)
      info.promptId = promptId
      this.emit('job:updated', { job: info })

      const outputs = await this.waitForOutput(promptId, template.kind, info, settings)
      info.outputs = outputs.map((o) => ({ file: o.file, kind: o.kind }))
      this.writeShotOutputs(params.shotId, outputs)
      await this.writeAssetOutputs(params.assetId, outputs) // 先落盘
      info.status = 'done'
      info.progress = 100
      info.finishedAt = now()
      // done 事件带上最新项目快照，前端直接用它刷新，避免重读磁盘的竞态
      this.emit('job:updated', { job: info, project: this.store.getCurrent() })
    } catch (err) {
      const project2 = this.store.getCurrent()
      const autoRetry = project2?.settings.autoRetry ?? 1
      // 超时不自动重试：视频往往只是慢/产物在 history 里，重试会重复生成浪费几小时
      const noRetry = (err as RetryableError).noRetry === true
      if (!noRetry && q.attempt < autoRetry) {
        q.attempt += 1
        this.queue.unshift(q)
        info.status = 'queued'
        info.error = `失败，准备第 ${q.attempt} 次重试：${String((err as Error).message ?? err)}`
      } else {
        info.status = 'failed'
        info.error = String((err as Error).message ?? err)
        info.finishedAt = now()
      }
      this.emit('job:updated', { job: info })
    } finally {
      this.client?.close()
      this.client = null
    }
  }

  private bindClientEvents(client: ComfyClient): void {
    client.on('progress', (p: { promptId?: string; percent: number; node?: string }) => {
      for (const job of this.jobs.values()) {
        if (job.promptId === p.promptId && job.status === 'running') {
          job.progress = p.percent
          this.emit('job:progress', { jobId: job.id, progress: p.percent, node: p.node })
        }
      }
    })
  }

  private async waitForOutput(
    promptId: string,
    kind: 'image' | 'video',
    info: JobInfo,
    settings: ComfySettings
  ): Promise<ShotOutput[]> {
    const client = this.client
    if (!client) throw new Error('ComfyUI 客户端未初始化')
    // H3/长视频在 6GB 显存上很慢；视频给 40 分钟，图片 10 分钟
    const timeoutMs = kind === 'video' ? 40 * 60 * 1000 : 10 * 60 * 1000

    return await new Promise<ShotOutput[]>((resolve, reject) => {
      let settled = false
      const timerHandles: ReturnType<typeof setInterval>[] = []
      const timeoutHandles: ReturnType<typeof setTimeout>[] = []
      const finish = (): void => {
        if (settled) return
        settled = true
        client.off('executed', onExecuted)
        client.off('execution_error', onError)
        for (const t of timerHandles) clearInterval(t)
        for (const t of timeoutHandles) clearTimeout(t)
      }
      // 收集到的所有产物（WS executed 多次事件 + history 兜底）
      const collected = new Map<string, MediaFile>()
      const addFiles = (files: MediaFile[]): void => {
        for (const f of files) if (f?.filename) collected.set(f.filename, f)
      }
      /** 从收集到的产物里挑最终版本：优先「三采/final」，否则最后一个 */
      const pickFinal = (): MediaFile[] => pickFinalMedia([...collected.values()], kind)
      /** 是否已拿到最终清晰版（三采/final）——视频任务必须等到它 */
      const hasFinalVersion = (): boolean =>
        kind !== 'video' || [...collected.values()].some((f) => /三采|final|_N471|3rd/i.test(f.filename))
      /** 等待最终清晰版的兜底超时（到了就按现有产物交付，不再无限等） */
      const FINAL_WAIT_MS = 12 * 60 * 1000
      const finalDeadline = Date.now() + FINAL_WAIT_MS
      let finalWaitExpired = false
      const finalTimeoutReached = (): boolean => finalWaitExpired || Date.now() >= finalDeadline
      /** 稍后重试交付（继续等最终清晰版） */
      const scheduleRetry = (): void => {
        if (settled) return
        const t = setTimeout(() => {
          void deliverFiles()
        }, 5000)
        timeoutHandles.push(t)
      }

      const deliverFiles = async (): Promise<void> => {
        if (settled) return
        // 每次交付前都重新读一次 history：
        //   - WS 可能只送来第一个输出节点（一采）
        //   - history 里有全部节点（一采/二采/三采），且随时间陆续补齐
        if (kind === 'video') {
          try {
            const hist = await client.history(promptId)
            const entry = hist[promptId] as { outputs?: Record<string, unknown> } | undefined
            if (entry?.outputs) addFiles(collectHistoryFiles(entry.outputs))
          } catch {
            // history 读不到就按已收集的交付
          }
        }
        const finalFiles = pickFinal()
        if (finalFiles.length === 0) return
        // 视频：若还没拿到最终清晰版（三采）且还能等，就先不交付，避免归档到中间版本
        if (kind === 'video' && !hasFinalVersion() && !finalTimeoutReached()) {
          scheduleRetry()
          return
        }
        finish()
        try {
          const media = this.store.mediaDir()
          const outputs: ShotOutput[] = []
          for (const f of finalFiles.slice(0, 12)) {
            const ext = path.extname(f.filename).slice(1).toLowerCase()
            const outKind: ShotOutput['kind'] = ['mp4', 'webm', 'mov'].includes(ext) || f.type === 'output' ? 'video' : 'image'
            const dest = path.join(media, f.filename)
            // BanZhang 节点给的是本地绝对路径(src_path)，优先直接复制；中文文件名也可靠
            if (f.src_path) {
              try {
                await fsp.copyFile(f.src_path, dest)
              } catch {
                await client.download(f.filename, f.subfolder, f.type, dest)
              }
            } else {
              await client.download(f.filename, f.subfolder, f.type, dest)
            }
            outputs.push({
              id: uid('out_'),
              file: dest,
              kind: kind === 'video' ? outKind : 'image',
              kept: true,
              promptId,
              status: 'done',
              progress: 100,
              createdAt: now()
            })
          }
          resolve(outputs)
        } catch (err) {
          reject(err as Error)
        }
      }

      // H3 三采工作流会依次输出 一采 → 二采 → 三采（三个独立节点，各自触发一次 WS executed）。
      // 若收到第一个产物就交付，归档到的会是"一采"而非最终清晰版。
      // 因此：视频任务一律等 history 显示 completed 后，再从 history 取全部输出节点，
      //       优先归档「三采/final」；图片任务（单节点产出）仍走 WS 快速路径。
      let collectTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleDeliver = (): void => {
        if (kind === 'video') return // 视频：等 history 完成信号
        if (collectTimer) return
        collectTimer = setTimeout(() => {
          collectTimer = null
          void deliverFiles()
        }, 2500)
        timeoutHandles.push(collectTimer)
      }

      const onExecuted = (e: { promptId?: string; output?: Record<string, unknown> }): void => {
        if (e.promptId !== promptId || settled) return
        addFiles(collectMediaFiles(e.output ?? {}))
        if (collected.size === 0) return // 有些节点把产物放别的字段，交给 history 兜底
        scheduleDeliver()
      }

      const onError = (e: { promptId?: string; message?: string }): void => {
        if (e.promptId !== promptId || settled) return
        finish()
        reject(new Error(e.message ?? 'ComfyUI 执行失败'))
      }

      /** 查 history：error 判失败，success/completed 时从 outputs 提产物 */
      const pollHistory = async (): Promise<boolean> => {
        if (settled) return true
        try {
          const history = await client.history(promptId)
          const entry = history[promptId] as
            | { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, unknown> }
            | undefined
          if (!entry) return false
          const status = entry.status?.status_str
          if (status === 'error') {
            finish()
            reject(new Error('ComfyUI 执行出错'))
            return true
          }
          const completed = entry.status?.completed === true || status === 'success'
          if (completed) {
            // history 里有全部输出节点（一采/二采/三采），全部加入后统一挑最终版
            addFiles(collectHistoryFiles(entry.outputs))
            if (collected.size > 0) {
              await deliverFiles()
            }
            // 视频还没拿到最终清晰版时继续轮询，等三采节点跑完
            if (kind === 'video' && !hasFinalVersion() && !finalTimeoutReached()) {
              return false
            }
            return true // 已完成，无论是否拿到文件都停止轮询
          }
        } catch {
          // 网络抖动，下次再查
        }
        return false
      }

      client.on('executed', onExecuted)
      client.on('execution_error', onError)

      // 兜底轮询：executed 没带文件时，从 history 提取（H3 产物常在 history.outputs）
      const poll = setInterval(() => { void pollHistory() }, 3000)
      timerHandles.push(poll)

      // 超时：先抢救一次 history（可能已完成但事件丢了），确认无产物才 fail 且不重试
      const to = setTimeout(() => {
        void (async () => {
          if (settled) return
          const doneBefore = await pollHistory()
          if (settled) return
          if (doneBefore) return
          // 最后兜底：如果已经收集到产物（哪怕只是中间版本），按现有产物交付，
          // 而不是直接判失败让用户白等。
          if (collected.size > 0) {
            finalWaitExpired = true // 放行：pickFinal 允许返回中间版本
            await deliverFiles()
            return
          }
          finish()
          const e = new Error(`生成超时（${Math.round(timeoutMs / 60000)} 分钟），可能仍在生成或产物未就绪，请到生成队列查看/手动重试`) as RetryableError
          e.noRetry = true
          reject(e)
        })()
      }, timeoutMs)
      timeoutHandles.push(to)
    })
  }

  private writeShotOutputs(shotId: string | undefined, outputs: ShotOutput[]): void {
    if (!shotId || outputs.length === 0) return
    const project = this.store.getCurrent()
    if (!project) return
    const shot = project.shots.find((s) => s.id === shotId)
    if (!shot) return
    // 同一分镜只保留一个"保留版本"：新产物入库时，旧的同段版本标记为弃用
    for (const o of shot.outputs) o.kept = false
    shot.outputs.push(...outputs)
    shot.status = 'done'
    void this.store.flush()
  }

  /** 图片生成完成后，把产物写进资产的 images + coverFile，供剧本分镜引用 */
  private async writeAssetOutputs(assetId: string | undefined, outputs: ShotOutput[]): Promise<void> {
    if (!assetId || outputs.length === 0) return
    const project = this.store.getCurrent()
    if (!project) return
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return
    const imageFiles = outputs.filter((o) => o.kind === 'image').map((o) => o.file)
    if (imageFiles.length === 0) return
    // 去重追加（同一 promptId 可能重复回调）
    for (const f of imageFiles) {
      if (!asset.images.includes(f)) asset.images.push(f)
    }
    if (!asset.coverFile) asset.coverFile = imageFiles[0]
    asset.updatedAt = now()
    await this.store.flush() // 等待落盘完成，避免前端重读磁盘读到旧数据
  }
}
