import path from 'node:path'
import type { ComfySettings, JobInfo, JobParams, JobStatus, ShotOutput, Template } from '@shared/types'
import { ComfyClient, makeClient } from './comfy'
import { buildWorkflow, extractH3Chain } from './workflow'
import { uid, now, ProjectStore } from './store'

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
export class JobManager {
  private jobs = new Map<string, JobInfo>()
  private queue: QueuedJob[] = []
  private running = false
  private client: ComfyClient | null = null
  private readonly emit: Emit

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
    this.queue.push({ info, params, template, settings: project.settings.comfy, attempt: 0 })
    this.emit('job:updated', { job: info })
    void this.pump()
    return info
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
        seed: params.seed
      })

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
      info.status = 'done'
      info.progress = 100
      info.finishedAt = now()
      this.writeShotOutputs(params.shotId, outputs)
    } catch (err) {
      const project2 = this.store.getCurrent()
      const autoRetry = project2?.settings.autoRetry ?? 1
      if (q.attempt < autoRetry) {
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
    const clientId = client.clientId
    return await new Promise<ShotOutput[]>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        client.off('executed', onExecuted)
        client.off('execution_error', onError)
        fn()
      }

      const onExecuted = (e: { promptId?: string; output?: Record<string, unknown> }): void => {
        if (e.promptId !== promptId) return
        const output = e.output ?? {}
        const images = (output.images ?? []) as { filename: string; subfolder: string; type: string }[]
        const videos = (output.videos ?? []) as { filename: string; subfolder: string; type: string }[]
        const gifs = (output.gifs ?? []) as { filename: string; subfolder: string; type: string }[]
        const files = [...videos, ...images, ...gifs]
        if (files.length === 0) {
          // 有些节点把产物放在别的 output 字段里，稍后轮询 history 兜底
          return
        }
        done(() => {
          void (async () => {
            try {
              const media = this.store.mediaDir()
              const outputs: ShotOutput[] = []
              for (const f of files.slice(0, 12)) {
                const ext = path.extname(f.filename).slice(1).toLowerCase()
                const outKind: ShotOutput['kind'] = ['mp4', 'webm', 'mov'].includes(ext) || f.type === 'output' ? 'video' : 'image'
                const dest = path.join(media, f.filename)
                await client.download(f.filename, f.subfolder, f.type, dest)
                outputs.push({
                  id: uid('out_'),
                  file: dest,
                  kind: kind === 'video' ? outKind : 'image',
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
          })()
        })
      }

      const onError = (e: { promptId?: string; message?: string }): void => {
        if (e.promptId !== promptId) return
        done(() => reject(new Error(e.message ?? 'ComfyUI 执行失败')))
      }

      client.on('executed', onExecuted)
      client.on('execution_error', onError)

      // 兜底：executed 事件没带来文件时，轮询 history
      const timer = setInterval(() => {
        if (settled) {
          clearInterval(timer)
          return
        }
        void client.history(promptId).then((history) => {
          if (settled) return
          const entry = history[promptId] as { status?: { completed?: boolean; status_str?: string } } | undefined
          if (entry?.status?.status_str === 'error') {
            clearInterval(timer)
            done(() => reject(new Error('ComfyUI 执行出错')))
          }
        }).catch(() => undefined)
      }, 3000)
      setTimeout(() => clearInterval(timer), 10 * 60 * 1000).unref()

      // 超时保护
      const timeout = setTimeout(() => {
        done(() => reject(new Error('生成超时（10 分钟）')))
      }, 10 * 60 * 1000)
      timeout.unref()

      void clientId
    })
  }

  private writeShotOutputs(shotId: string | undefined, outputs: ShotOutput[]): void {
    if (!shotId || outputs.length === 0) return
    const project = this.store.getCurrent()
    if (!project) return
    const shot = project.shots.find((s) => s.id === shotId)
    if (!shot) return
    shot.outputs.push(...outputs)
    shot.status = 'done'
    void this.store.flush()
  }
}
