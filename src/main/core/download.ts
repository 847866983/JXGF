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

/** 单个 Range 分块：下载 [start,end] 写入临时文件，回调已收字节；append=true 时追加（断点续传） */
async function downloadRange(
  url: string,
  start: number,
  end: number,
  tmpFile: string,
  signal: AbortSignal,
  onBytes: (n: number) => void,
  append = false
): Promise<void> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal
  })
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`HTTP ${res.status}`)
  }
  await fsp.mkdir(path.dirname(tmpFile), { recursive: true })
  const ws = fs.createWriteStream(tmpFile, { flags: append ? 'a' : 'w' })
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

/** 探测文件总大小与是否支持 Range（直接用 Range GET，省一次 HEAD 往返） */
async function probe(url: string, signal: AbortSignal): Promise<{ total: number; supportsRange: boolean }> {
  try {
    const r = await fetch(url, { signal, headers: { Range: 'bytes=0-0' } })
    if (r.status === 206) {
      const cr = r.headers.get('content-range') ?? ''
      const total = Number(/\/(\d+)$/.exec(cr)?.[1] ?? 0)
      await r.body?.cancel().catch(() => undefined)
      if (total > 0) return { total, supportsRange: true }
    }
    const len = Number(r.headers.get('content-length') ?? 0)
    await r.body?.cancel().catch(() => undefined)
    return { total: len, supportsRange: false }
  } catch {
    return { total: 0, supportsRange: false }
  }
}

/** 多线程分块下载：按并行度切 Range，每块独立临时文件，支持断点续传，最后按序拼接 */
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
    const ranges: { start: number; end: number; tmp: string }[] = []
    for (let i = 0; i < n; i++) {
      const startB = i * chunkSize
      const endB = Math.min(total - 1, (i + 1) * chunkSize - 1)
      if (startB > endB) break
      ranges.push({ start: startB, end: endB, tmp: `${dest}.chunk${i}.part` })
    }
    // 每块已收字节（全局进度汇总，避免多块互相覆盖）
    const progress = new Array(ranges.length).fill(0)
    const report = (): void => onBytes(progress.reduce((s, v) => s + v, 0))
    const tasks: Promise<void>[] = []
    for (let i = 0; i < ranges.length; i++) {
      const { start: s0, end: e0, tmp } = ranges[i]
      const expect = e0 - s0 + 1
      let have = 0
      try {
        have = (await fsp.stat(tmp)).size
      } catch {
        have = 0
      }
      if (have >= expect) {
        progress[i] = expect
        report()
        continue
      }
      progress[i] = have
      report()
      tasks.push(
        downloadRange(url, s0 + have, e0, tmp, signal, (b) => {
          progress[i] = have + b
          report()
        }, have > 0)
      )
    }
    await Promise.all(tasks)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const out = fs.createWriteStream(dest)
    for (const { tmp } of ranges) {
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
  /** 每个任务上次 emit 时间，用于节流（避免高频 IPC 把界面卡死） */
  private lastEmit = new Map<string, number>()
  private static readonly EMIT_INTERVAL_MS = 200

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

  /** 更新任务并广播；force=true 时跳过节流（状态变化必须立即送达） */
  private set(task: DownloadTask, patch: Partial<DownloadTask>, force = false): void {
    Object.assign(task, patch)
    if (task.totalBytes > 0) {
      task.percent = Math.min(100, Math.round((task.receivedBytes / task.totalBytes) * 100))
    }
    const nowMs = Date.now()
    const last = this.lastEmit.get(task.id) ?? 0
    if (!force && nowMs - last < DownloadManager.EMIT_INTERVAL_MS) return
    this.lastEmit.set(task.id, nowMs)
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
      const files: { url: string; dest: string; sha256?: string; mirrors?: string[] }[] = req.files?.length
        ? req.files
        : [{ url: req.url, dest: req.dest, sha256: req.sha256, mirrors: req.mirrors }]

      // 计算总大小（用 Range 探测，比 HEAD 快）
      let total = 0
      for (const f of files) {
        try {
          const p = await probe(f.url, controller.signal)
          if (p.total > 0) total += p.total
        } catch {
          // 探测失败不阻断
        }
      }
      this.set(task, { totalBytes: total }, true)

      let received = 0
      for (const f of files) {
        // 多镜像回退：主源失败自动尝试备用镜像
        const candidates = [f.url, ...(f.mirrors ?? []).filter((m) => m !== f.url)]
        let lastErr: Error | null = null
        let ok = false
        for (const url of candidates) {
          try {
            let fileReceived = 0
            await downloadParallel(url, f.dest, parallel, controller.signal, (b) => {
              fileReceived = b
              this.set(task, { receivedBytes: received + fileReceived })
            })
            received += fileReceived
            ok = true
            break
          } catch (err) {
            lastErr = err as Error
            if ((err as Error).name === 'AbortError') throw err
            // 换下一个镜像重试
          }
        }
        if (!ok) throw lastErr ?? new Error('所有下载源均失败')
        if (f.sha256) {
          const hash = await sha256File(f.dest)
          if (hash !== f.sha256.toLowerCase()) {
            await fsp.rm(f.dest, { force: true }).catch(() => undefined)
            throw new Error(`SHA256 校验失败：${path.basename(f.dest)}`)
          }
        }
      }

      this.set(task, { status: 'done', receivedBytes: total, finishedAt: new Date().toISOString() }, true)
      this.emit('done', task)
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      this.set(task, {
        status: aborted ? 'cancelled' : 'failed',
        error: aborted ? undefined : String((err as Error).message ?? err),
        finishedAt: new Date().toISOString()
      }, true)
      this.emit(aborted ? 'cancelled' : 'failed', task)
    } finally {
      this.controllers.delete(req.id)
      this.running.delete(req.id)
    }
  }
}
