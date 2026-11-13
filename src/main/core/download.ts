import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DownloadRequest, DownloadTask } from '@shared/types'

async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve(hash.digest('hex')))
    s.on('error', reject)
  })
}

/**
 * 断点续传下载引擎（纯 Node，不依赖 Electron，便于单测）。
 * - 下载到 `<dest>.part`，完成后原子 rename 到 dest
 * - 已存在的 .part 会通过 HTTP Range 继续下载
 * - 提供 SHA256 校验、取消、进度事件
 */
export class DownloadManager extends EventEmitter {
  private tasks = new Map<string, DownloadTask>()
  private controllers = new Map<string, AbortController>()
  private running = new Set<string>()

  list(): DownloadTask[] {
    return [...this.tasks.values()]
  }

  start(req: DownloadRequest): DownloadTask {
    const existing = this.tasks.get(req.id)
    if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
      return existing
    }
    const task: DownloadTask = {
      id: req.id,
      label: req.label,
      url: req.url,
      dest: req.dest,
      status: 'queued',
      receivedBytes: 0,
      totalBytes: 0,
      percent: 0,
      startedAt: new Date().toISOString()
    }
    this.tasks.set(req.id, task)
    this.emit('state', task)
    void this.run(req, task)
    return task
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort()
  }

  private set(task: DownloadTask, patch: Partial<DownloadTask>): void {
    Object.assign(task, patch)
    if (task.totalBytes > 0) {
      task.percent = Math.min(100, Math.round((task.receivedBytes / task.totalBytes) * 100))
    }
    this.emit('state', task)
  }

  private async run(req: DownloadRequest, task: DownloadTask): Promise<void> {
    if (this.running.has(req.id)) return
    this.running.add(req.id)
    const controller = new AbortController()
    this.controllers.set(req.id, controller)
    const part = `${req.dest}.part`
    this.set(task, { status: 'downloading' })
    try {
      let start = 0
      try {
        start = (await fsp.stat(part)).size
      } catch {
        // 没有部分文件，从头下载
      }

      const headers: Record<string, string> = {}
      if (start > 0) headers['Range'] = `bytes=${start}-`
      const res = await fetch(req.url, { headers, signal: controller.signal })
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`)
      }

      let total = start
      if (res.status === 206) {
        const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')
        if (m) total = Number(m[1])
      } else {
        const len = Number(res.headers.get('content-length') ?? 0)
        total = start + (len || 0)
      }
      this.set(task, { totalBytes: total })

      await fsp.mkdir(path.dirname(req.dest), { recursive: true })
      const ws = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
      const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader()
      let received = start
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!ws.write(Buffer.from(value))) {
          await new Promise<void>((r) => ws.once('drain', r))
        }
        received += value.length
        this.set(task, { receivedBytes: received })
      }
      await new Promise<void>((resolve, reject) => {
        ws.end()
        ws.on('finish', resolve)
        ws.on('error', reject)
      })

      if (req.sha256) {
        const hash = await sha256File(part)
        if (hash !== req.sha256.toLowerCase()) {
          await fsp.rm(part, { force: true }).catch(() => undefined)
          throw new Error('SHA256 校验失败')
        }
      }

      await fsp.rename(part, req.dest)
      this.set(task, { status: 'done', receivedBytes: total, finishedAt: new Date().toISOString() })
      this.emit('done', task)
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      this.set(task, {
        status: aborted ? 'cancelled' : 'failed',
        error: aborted ? undefined : String((err as Error).message ?? err),
        finishedAt: new Date().toISOString()
      })
      this.emit(aborted ? 'cancelled' : 'failed', task)
    } finally {
      this.controllers.delete(req.id)
      this.running.delete(req.id)
    }
  }
}
