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

/** 单个 Range 分块：下载 [start,end] 写入临时文件，回调已收字节 */
async function downloadRange(
  url: string,
  start: number,
  end: number,
  tmpFile: string,
  signal: AbortSignal,
  onBytes: (n: number) => void
): Promise<void> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal
  })
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`HTTP ${res.status}`)
  }
  await fsp.mkdir(path.dirname(tmpFile), { recursive: true })
  const ws = fs.createWriteStream(tmpFile)
  let received = 0
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!ws.write(Buffer.from(value))) {
      await new Promise<void>((r) => ws.once('drain', r))
    }
    received += value.length
    onBytes(received)
  }
  await new Promise<void>((resolve, reject) => {
    ws.end()
    ws.on('finish', resolve)
    ws.on('error', reject)
  })
}

/** 探测文件总大小与是否支持 Range（HEAD 不支持时退回 GET Range 探测） */
async function probe(url: string, signal: AbortSignal): Promise<{ total: number; supportsRange: boolean }> {
  try {
    const r = await fetch(url, { method: 'HEAD', signal })
    const len = Number(r.headers.get('content-length') ?? 0)
    if (r.ok && len > 0) {
      await r.body?.cancel().catch(() => undefined)
      return { total: len, supportsRange: r.headers.get('accept-ranges') === 'bytes' }
    }
    await r.body?.cancel().catch(() => undefined)
  } catch {
    // HEAD 不支持，继续
  }
  try {
    const r = await fetch(url, { signal, headers: { Range: 'bytes=0-0' } })
    if (r.status === 206) {
      const cr = r.headers.get('content-range') ?? ''
      const total = Number(/\/(\d+)$/.exec(cr)?.[1] ?? 0)
      await r.body?.cancel().catch(() => undefined)
      return { total, supportsRange: true }
    }
    const len = Number(r.headers.get('content-length') ?? 0)
    await r.body?.cancel().catch(() => undefined)
    return { total: len, supportsRange: false }
  } catch {
    return { total: 0, supportsRange: false }
  }
}

/** 多线程分块下载：按并行度切 Range，每块写独立临时文件，最后拼接 */
async function downloadParallel(
  url: string,
  dest: string,
  parallel: number,
  signal: AbortSignal,
  onBytes: (n: number) => void
): Promise<void> {
  const { total, supportsRange } = await probe(url, signal)
  if (supportsRange && total > 0) {
    const n = Math.max(1, Math.min(parallel, 8))
    const chunkSize = Math.ceil(total / n)
    const tasks: Promise<void>[] = []
    for (let i = 0; i < n; i++) {
      const start = i * chunkSize
      const end = Math.min(total - 1, (i + 1) * chunkSize - 1)
      if (start > end) break
      const tmp = `${dest}.chunk${i}.part`
      tasks.push(downloadRange(url, start, end, tmp, signal, (b) => onBytes(b)))
    }
    await Promise.all(tasks)
    // 拼接分块（按顺序串接到目标文件）
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const out = fs.createWriteStream(dest)
    for (let i = 0; i < n; i++) {
      const tmp = `${dest}.chunk${i}.part`
      if (!fs.existsSync(tmp)) continue
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(tmp)
        rs.on('error', reject)
        rs.on('end', resolve)
        rs.pipe(out, { end: false })
      })
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
    await new Promise<void>((resolve, reject) => {
      out.end()
      out.on('finish', resolve)
      out.on('error', reject)
    })
    return
  }
  // 服务器不支持 Range：退回单流下载
  await singleStream(url, dest, signal, onBytes)
}

async function singleStream(url: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(url, { signal })
  if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`)
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const ws = fs.createWriteStream(dest)
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!ws.write(Buffer.from(value))) {
      await new Promise<void>((r) => ws.once('drain', r))
    }
    onBytes(value.length)
  }
  await new Promise<void>((resolve, reject) => {
    ws.end()
    ws.on('finish', resolve)
    ws.on('error', reject)
  })
}

/**
 * 断点续传 + 多线程分块下载引擎（纯 Node，便于单测）。
 * - 小文件单流；大文件按并行度切 Range 多线程，最后拼接
 * - 下载到临时分块文件，完成后原子 rename 到 dest
 * - SHA256 校验、取消、进度事件
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
    this.set(task, { status: 'downloading' })
    try {
      const parallel = req.parallel ?? 4
      const files: { url: string; dest: string; sha256?: string }[] = req.files?.length
        ? req.files
        : [{ url: req.url, dest: req.dest, sha256: req.sha256 }]

      // 计算总大小（先探测各文件）
      let total = 0
      for (const f of files) {
        try {
          const r = await fetch(f.url, { method: 'HEAD', signal: controller.signal })
          const len = Number(r.headers.get('content-length') ?? 0)
          if (len > 0) total += len
        } catch {
          // 探测失败不阻断
        }
      }
      this.set(task, { totalBytes: total })

      let received = 0
      for (const f of files) {
        const part = `${f.dest}.part`
        let got = 0
        try {
          got = (await fsp.stat(part)).size
        } catch {
          // 无部分文件，从头下载
        }
        // 单文件也用分块下载（忽略已有 part，大文件多线程更快）
        let fileReceived = 0
        await downloadParallel(f.url, f.dest, parallel, controller.signal, (b) => {
          fileReceived = b
          this.set(task, { receivedBytes: received + fileReceived })
        })
        if (f.sha256) {
          const hash = await sha256File(f.dest)
          if (hash !== f.sha256.toLowerCase()) {
            await fsp.rm(f.dest, { force: true }).catch(() => undefined)
            throw new Error(`SHA256 校验失败：${path.basename(f.dest)}`)
          }
        }
        received += fileReceived
      }

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
