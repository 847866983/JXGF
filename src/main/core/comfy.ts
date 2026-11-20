import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import type { ComfySettings, ComfySystemStats, ModelInventory } from '@shared/types'

export interface UploadedImage {
  name: string
  subfolder: string
  type: string
}

interface WsExecutedPayload {
  prompt_id: string
  node: string
  output?: {
    images?: { filename: string; subfolder: string; type: string }[]
    videos?: { filename: string; subfolder: string; type: string }[]
    gifs?: { filename: string; subfolder: string; type: string }[]
  }
}

/**
 * ComfyUI 的薄客户端。业务层只跟它打交道，不直接拼 API。
 * 通道：POST /upload/image、POST /prompt、WS /ws、GET /history、GET /view。
 */
export class ComfyClient extends EventEmitter {
  readonly clientId = crypto.randomUUID()
  private ws: WebSocket | null = null
  private wsReady = false
  private readonly host: string
  private readonly port: number
  private readonly protocol: 'http' | 'https'

  constructor(host = '127.0.0.1', port = 8188, protocol: 'http' | 'https' = 'http') {
    super()
    this.host = host
    this.port = port
    this.protocol = protocol
  }

  get base(): string {
    return `${this.protocol}://${this.host}:${this.port}`
  }

  async systemStats(): Promise<ComfySystemStats> {
    try {
      const res = await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = (await res.json()) as Record<string, unknown>
      const sys = (raw.system ?? {}) as Record<string, unknown>
      const devices = Array.isArray(raw.devices) ? (raw.devices as Array<Record<string, unknown>>) : []
      const gpu = devices[0]
      const ramTotal = Number(sys.ram_total ?? 0)
      const ramFree = Number(sys.ram_free ?? 0)
      return {
        online: true,
        version: String(sys.comfyui_version ?? sys.version ?? ''),
        gpu: gpu
          ? {
              name: String(gpu.name ?? ''),
              vramTotal: Number(gpu.vram_total ?? 0),
              vramFree: Number(gpu.vram_free ?? 0)
            }
          : null,
        ram: ramTotal > 0 ? { total: ramTotal, free: ramFree } : null,
        cpuAvailable: true,
        queueRemaining: 0,
        queueRunning: 0,
        raw
      }
    } catch {
      return { online: false, version: '', gpu: null, ram: null, cpuAvailable: false, queueRemaining: 0, queueRunning: 0 }
    }
  }

  async queueStatus(): Promise<{ queueRemaining: number; queueRunning: number }> {
    try {
      const res = await fetch(`${this.base}/queue`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] }
      return {
        queueRunning: data.queue_running?.length ?? 0,
        queueRemaining: data.queue_pending?.length ?? 0
      }
    } catch {
      return { queueRemaining: 0, queueRunning: 0 }
    }
  }

  /**
   * 读取 /object_info，提取常见加载节点能选到的模型清单。
   * 不同自定义节点可能有不同的加载器，这里只列最通用的三类作为环境自检参考。
   */
  async modelInventory(): Promise<ModelInventory> {
    const res = await fetch(`${this.base}/object_info`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const info = (await res.json()) as Record<string, unknown>
    const pick = (node: string, key: string): string[] => {
      const nodeInfo = info[node] as { input?: { required?: Record<string, unknown> } } | undefined
      const arr = nodeInfo?.input?.required?.[key]
      const list = Array.isArray(arr) ? (arr[0] as unknown[]) : []
      return Array.isArray(list) ? list.map(String) : []
    }
    return {
      checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name'),
      loras: pick('LoraLoader', 'lora_name'),
      vaes: pick('VAELoader', 'vae_name')
    }
  }

  async uploadImage(filePath: string): Promise<UploadedImage> {
    const buf = await fsp.readFile(filePath)
    const form = new FormData()
    form.append('image', new Blob([buf]), path.basename(filePath))
    form.append('overwrite', 'true')
    const res = await fetch(`${this.base}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`上传参考图失败：HTTP ${res.status} ${await res.text()}`)
    return (await res.json()) as UploadedImage
  }

  async submit(workflow: unknown): Promise<string> {
    const res = await fetch(`${this.base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`提交工作流失败：HTTP ${res.status} ${text.slice(0, 400)}`)
    }
    const data = (await res.json()) as { prompt_id?: string; error?: string }
    if (!data.prompt_id) throw new Error(data.error ?? 'ComfyUI 未返回 prompt_id')
    return data.prompt_id
  }

  /**
   * 登记 H3 链式续接的工程名 + 当前段（BanZhang 存档节点要求）。
   * 提交工作流前调用，否则「💾 H3 续拍存档」节点会报「先让导演台登记当前段」。
   * 幂等：同一 shot 重复登记返回已有段 id，不会越堆越多。
   */
  async registerClip(name: string, opts: { shot?: string; frames?: number } = {}): Promise<string> {
    const body: Record<string, unknown> = { name }
    if (opts.shot) body.shot = opts.shot
    if (opts.frames) body.frames = opts.frames
    const res = await fetch(`${this.base}/cglide/chain/add_clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`登记段落失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { id?: string; error?: string }
    if (!data.id) throw new Error(data.error ?? '登记段落未返回 id')
    return data.id
  }

  /**
   * 查一个工程里已登记的段（/cglide/chain/summary）。
   * 用来把「本段」和 H3 导演台档案里的段 id 对上——只有拿到段 id 才能查续拍存档。
   */
  async chainSummary(name: string): Promise<{ clips: { id: string; shot?: string; current_take?: number }[] }> {
    const url = new URL(`${this.base}/cglide/chain/summary`)
    url.searchParams.set('name', name)
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`读取工程档案失败：HTTP ${res.status}`)
    const data = (await res.json()) as { clips?: { id: string; shot?: string; current_take?: number }[] }
    return { clips: Array.isArray(data.clips) ? data.clips : [] }
  }

  /**
   * 取某一段当前版本的续拍存档路径（相对 output）。
   * 这就是「潜空间续写」的源：下一段把这个路径写进 cont.latent_file 就能承接。
   */
  async chainCont(name: string, cid: string): Promise<{ cont_path?: string; take?: number; error?: string }> {
    const url = new URL(`${this.base}/cglide/chain/cont`)
    url.searchParams.set('name', name)
    url.searchParams.set('id', cid)
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return (await res.json()) as { cont_path?: string; take?: number; error?: string }
  }

  /**
   * 整片成片视图（导演台监视器/时间轴的数据源）。
   * 每段返回在全片里的净起止帧、累积成片路径、可播状态、承接帧数与版本号。
   */
  async filmSummary(name: string): Promise<Record<string, unknown>> {
    const url = new URL(`${this.base}/cglide/chain/film_summary`)
    url.searchParams.set('name', name)
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) throw new Error(`读取成片时间轴失败：HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  /** 单条成片的音频峰值包络（时间轴波形层用） */
  async joinWaveform(video: string, bins = 1200): Promise<{ bins?: number[]; duration?: number; error?: string }> {
    const url = new URL(`${this.base}/cglide/join/waveform`)
    url.searchParams.set('video', video)
    url.searchParams.set('bins', String(bins))
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return (await res.json()) as { bins?: number[]; duration?: number; error?: string }
  }

  /** ComfyUI 的基地址（渲染进程拼 <img>/<video> 的直链用） */
  baseUrl(): string {
    return this.base
  }

  /**
   * 成片登记：按 prompt_id 让中央档案把这次渲染的成片认领到某一段。
   * 时间轴/监视器读的 film_summary 里那段有没有 film 就靠这一步。
   * 幂等：同一 prompt_id 重复调用只收一次。
   */
  async collectRun(name: string, cid: string, promptId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/cglide/chain/collect_run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, id: cid, prompt_id: promptId })
    })
    if (!res.ok) throw new Error(`成片登记失败：HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  async connect(): Promise<void> {
    if (this.wsReady) return
    await new Promise<void>((resolve, reject) => {
      const url = `${this.protocol === 'https' ? 'wss' : 'ws'}://${this.host}:${this.port}/ws?clientId=${this.clientId}`
      const ws = new WebSocket(url)
      this.ws = ws
      const fail = (err: Error): void => {
        this.wsReady = false
        reject(err)
      }
      ws.on('open', () => {
        this.wsReady = true
        resolve()
      })
      ws.on('error', fail)
      ws.on('close', () => {
        this.wsReady = false
      })
      ws.on('message', (raw) => {
        this.handleMessage(raw.toString())
      })
    })
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as Record<string, unknown>
      const type = String(msg.type ?? '')
      if (type === 'progress') {
        const data = (msg.data ?? {}) as { value?: number; max?: number; prompt_id?: string; node?: string }
        const value = Number(data.value ?? 0)
        const max = Number(data.max ?? 1)
        this.emit('progress', {
          promptId: data.prompt_id,
          node: data.node,
          value,
          max,
          percent: max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
        })
      } else if (type === 'executing') {
        const data = (msg.data ?? {}) as { node?: unknown; prompt_id?: string }
        this.emit('executing', { promptId: data.prompt_id, node: data.node ? String(data.node) : null })
      } else if (type === 'executed') {
        const data = (msg.data ?? {}) as WsExecutedPayload
        this.emit('executed', { promptId: data.prompt_id, output: data.output ?? {} })
      } else if (type === 'execution_cached') {
        // ComfyUI 判定某些节点与上次完全一致、直接复用结果时发这个事件。
        // 若连采样器都在缓存里，说明这一轮根本没真跑 —— 产出的只是上一次的旧文件。
        const data = (msg.data ?? {}) as { nodes?: unknown[]; prompt_id?: string }
        this.emit('execution_cached', {
          promptId: data.prompt_id,
          nodes: Array.isArray(data.nodes) ? data.nodes.map((n) => String(n)) : []
        })
      } else if (type === 'execution_error') {
        const data = (msg.data ?? {}) as { prompt_id?: string; exception_message?: string }
        this.emit('execution_error', { promptId: data.prompt_id, message: data.exception_message ?? '执行失败' })
      }
    } catch {
      // 忽略无法解析的消息
    }
  }

  async history(promptId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/history/${promptId}`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`读取历史失败：HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  async download(filename: string, subfolder: string, type: string, destPath: string): Promise<string> {
    const url = new URL(`${this.base}/view`)
    url.searchParams.set('filename', filename)
    url.searchParams.set('subfolder', subfolder)
    url.searchParams.set('type', type)
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`)
    await fsp.mkdir(path.dirname(destPath), { recursive: true })
    const ws = fs.createWriteStream(destPath)
    // Node fetch body 是 web stream，转成 Node 可写流
    const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader()
    await new Promise<void>((resolve, reject) => {
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!ws.write(Buffer.from(value))) {
              await new Promise<void>((r) => ws.once('drain', r))
            }
          }
          ws.end()
          resolve()
        } catch (err) {
          ws.destroy()
          reject(err)
        }
      }
      ws.on('error', reject)
      pump()
    })
    await new Promise<void>((resolve) => ws.once('finish', resolve))
    return destPath
  }

  async interrupt(): Promise<void> {
    await fetch(`${this.base}/interrupt`, { method: 'POST' }).catch(() => undefined)
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    this.wsReady = false
  }
}

export function makeClient(settings: ComfySettings): ComfyClient {
  return new ComfyClient(settings.host, settings.port, settings.protocol)
}
