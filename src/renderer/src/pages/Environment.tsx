import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, CheckCircle2, Cpu, Download, FileUp, FolderOpen, Package, PackagePlus, Play, RefreshCw, ServerCog, Square, TriangleAlert } from 'lucide-react'
import type { CatalogItem, ComfyInstallState, ComfyRuntimeState, DownloadTask, EnvironmentReport } from '@shared/types'
import { PageHeader } from '../components/ui'

const modeText: Record<string, { label: string; tone: string }> = {
  'local-full': { label: '本地全功能（视频+图片）', tone: 'text-emerald-400' },
  'local-image': { label: '本地仅图片', tone: 'text-amber-400' },
  remote: { label: '远程模式', tone: 'text-sky-400' }
}

const runtimeText: Record<string, { label: string; tone: string }> = {
  missing: { label: '未安装', tone: 'text-slate-400' },
  installed: { label: '已安装（未运行）', tone: 'text-amber-400' },
  starting: { label: '启动中…', tone: 'text-accent-400' },
  running: { label: '运行中', tone: 'text-emerald-400' },
  stopped: { label: '已停止', tone: 'text-slate-400' },
  error: { label: '出错', tone: 'text-rose-400' }
}

export default function Environment({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const navigate = useNavigate()
  const [report, setReport] = useState<EnvironmentReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [sourceIndex, setSourceIndex] = useState<Record<string, number>>({})
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<ComfyRuntimeState | null>(null)
  const [runtimeRoot, setRuntimeRoot] = useState('')
  const [runtimePort, setRuntimePort] = useState('8188')
  const [busy, setBusy] = useState(false)
  const [install, setInstall] = useState<ComfyInstallState | null>(null)
  const [nodePack, setNodePack] = useState<{ installed: boolean } | null>(null)
  const [nodePackBusy, setNodePackBusy] = useState(false)
  const [nodePackMsg, setNodePackMsg] = useState<string | null>(null)
  /** 每条下载项的进度快照（id -> task） */
  const [tasks, setTasks] = useState<Record<string, DownloadTask>>({})
  /** 每条任务上次前端刷新时间（节流用） */
  const lastTaskUpdate = useRef<Record<string, number>>({})
  /** 模型搬家：模板引用的模型清单 */
  const [modelList, setModelList] = useState<{ name: string; relativePath: string; absPath: string | null; sizeMB: number; exists: boolean; usedBy: string[] }[]>([])
  const [selectedModels, setSelectedModels] = useState<Record<string, boolean>>({})
  const [modelMsg, setModelMsg] = useState<string | null>(null)
  const [modelBusy, setModelBusy] = useState(false)

  const loadModels = async (): Promise<void> => {
    try {
      const list = (await window.api.modelPackList()) as typeof modelList
      setModelList(list)
      setSelectedModels(Object.fromEntries(list.filter((m) => m.exists).map((m) => [m.name, true])))
    } catch (err) {
      setModelMsg(String((err as Error).message ?? err))
    }
  }

  const doExportModels = async (): Promise<void> => {
    const items = modelList.filter((m) => m.exists && selectedModels[m.name] && m.absPath).map((m) => ({ absPath: m.absPath as string, relativePath: m.relativePath }))
    if (items.length === 0) { setModelMsg('请先勾选要导出的模型'); return }
    setModelBusy(true); setModelMsg(null)
    try {
      const r = (await window.api.modelPackExport(items)) as { canceled: boolean; file?: string }
      setModelMsg(r.canceled ? '已取消' : '导出完成：' + r.file)
    } catch (err) { setModelMsg('导出失败：' + String((err as Error).message ?? err)) } finally { setModelBusy(false) }
  }

  const doImportModels = async (): Promise<void> => {
    setModelBusy(true)
    setModelMsg(null)
    try {
      const r = (await window.api.modelPackImport()) as { canceled: boolean; file?: string }
      setModelMsg(r.canceled ? '\u5df2\u53d6\u6d88' : '\u5bfc\u5165\u5b8c\u6210\uff1a' + r.file)
      await loadModels()
    } catch (err) {
      setModelMsg('\u5bfc\u5165\u5931\u8d25\uff1a' + String((err as Error).message ?? err))
    } finally {
      setModelBusy(false)
    }
  }

  const refreshNodePack = async (root: string): Promise<void> => {
    if (!root.trim()) return
    try {
      const st = (await window.api.nodePackStatus(root)) as { installed: boolean }
      setNodePack(st)
    } catch {
      setNodePack(null)
    }
  }

  const installNodePack = async (): Promise<void> => {
    if (!runtimeRoot.trim()) return
    setNodePackBusy(true)
    setNodePackMsg(null)
    try {
      const r = (await window.api.nodePackInstall(runtimeRoot.trim())) as { installedDir: string; skipped: boolean }
      setNodePackMsg(r.skipped ? '节点包已存在，无需重复安装' : '节点包安装完成，重启 ComfyUI 后生效')
      await refreshNodePack(runtimeRoot.trim())
    } catch (err) {
      setNodePackMsg(`安装失败：${String((err as Error).message ?? err)}`)
    } finally {
      setNodePackBusy(false)
    }
  }

  const startOneClickInstall = async (): Promise<void> => {
    setInstall({ phase: 'downloading', percent: 0, message: '准备安装…' })
    try {
      await window.api.comfyInstallStart()
    } catch (err) {
      setInstall({ phase: 'error', percent: 0, message: '安装失败', error: String((err as Error).message ?? err) })
    }
  }

  /** 下载某条：单文件或工作流包，多线程镜像下载，进度归到本条 */
  const downloadItem = async (item: CatalogItem): Promise<void> => {
    const idx = sourceIndex[item.id] ?? 0
    const srcIdx = (item.files?.[0]?.sources ?? item.sources ?? [])[idx] ? idx : 0
    const pickSource = (i: number): { name: string; url: string } | undefined =>
      (item.files?.[0]?.sources ?? item.sources ?? [])[i]
    const s0 = pickSource(srcIdx) ?? { name: '', url: '' }

    if (item.files && item.files.length > 0) {
      const src = item.files[0].sources[srcIdx] ?? item.files[0].sources[0]
      const files = item.files.map((f) => {
        // 当前选中源优先，其余镜像作为备用自动回退
        const ordered = [f.sources[srcIdx] ?? f.sources[0], ...f.sources].filter(Boolean)
        const uniq = [...new Map(ordered.map((s) => [s.url, s])).values()]
        return {
          url: uniq[0].url,
          dest: f.dest,
          mirrors: uniq.slice(1).map((s) => s.url)
        }
      })
      await window.api.downloadStart({ id: item.id, label: item.label, url: src.url, dest: item.dest ?? '', files, parallel: 4 })
    } else {
      const src = s0
      await window.api.downloadStart({
        id: item.id,
        label: item.label,
        url: src.url,
        dest: item.dest ?? '',
        parallel: 4
      })
    }
  }

  const scan = (): void => {
    setLoading(true)
    setError(null)
    window.api
      .envScan()
      .then(setReport)
      .catch((err) => setError(String((err as Error).message ?? err)))
      .finally(() => setLoading(false))
  }

  const refreshCatalog = (): void => {
    void window.api.envCatalog().then(setCatalog)
  }

  const doExtract = async (item: CatalogItem): Promise<void> => {
    setExtractingId(item.id)
    try {
      if (!item.dest || !item.extractedDir) throw new Error('缺少解压路径')
      await window.api.envExtract({ archive: item.dest, dest: item.extractedDir })
      refreshCatalog()
    } catch (err) {
      setError(`解压失败：${String((err as Error).message ?? err)}`)
    } finally {
      setExtractingId(null)
    }
  }

  const refreshRuntime = (): void => {
    void window.api.comfyRuntimeStatus().then((st) => {
      setRuntime(st)
      setRuntimeRoot(st.root ?? '')
      setRuntimePort(String(st.port ?? 8188))
      if (st.root) void refreshNodePack(st.root)
    })
  }

  const startRuntime = async (): Promise<void> => {
    setBusy(true)
    try {
      setRuntime(await window.api.comfyRuntimeStart())
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const stopRuntime = async (): Promise<void> => {
    setBusy(true)
    try {
      setRuntime(await window.api.comfyRuntimeStop())
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const saveRuntimeConfig = async (): Promise<void> => {
    try {
      await window.api.comfyRuntimeSetConfig({
        root: runtimeRoot.trim() || null,
        port: Number(runtimePort) || 8188,
        python: null
      })
      refreshRuntime()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    }
  }

  useEffect(() => {
    scan()
    refreshCatalog()
    refreshRuntime()
  }, [])

  useEffect(() => {
    void window.api.downloadList().then((list) => {
      const m: Record<string, DownloadTask> = {}
      for (const t of list) m[t.id] = t
      setTasks(m)
    })
    return window.api.onEvent((e) => {
      if (e.type === 'download:state') {
        const task = e.task as DownloadTask
        const finished = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled'
        const nowMs = Date.now()
        const last = lastTaskUpdate.current[task.id] ?? 0
        // 每个任务独立节流 500ms：避免高频进度更新引起整页重渲染卡顿（结束时立即更新）
        if (!finished && nowMs - last < 500) return
        lastTaskUpdate.current[task.id] = nowMs
        setTasks((prev) => ({ ...prev, [task.id]: task }))
        if (finished) refreshCatalog()
      }
      if (e.type === 'model-pack:progress') setModelMsg((e as { message?: string }).message ?? null)
      if (e.type === 'comfy:runtime') setRuntime(e.state)
      if (e.type === 'comfy:install') {
        setInstall(e.state)
        if (e.state.phase === 'done') {
          refreshRuntime()
          refreshCatalog()
          scan()
        }
      }
    })
  }, [])

  const gpu = report?.gpu
  const comfy = report?.comfy
  const models = report?.models
  const mode = modeText[gpu?.comfyMode ?? 'remote']

  return (
    <div>
      {embedded ? (
        <div className="flex items-center justify-between px-8 pb-4">
          <div className="text-xs text-slate-500">面向本机配置的检测与安装：能做什么、缺什么、怎么补</div>
          <button className="btn-ghost" onClick={scan} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            {loading ? '检测中…' : '重新检测'}
          </button>
        </div>
      ) : (
        <PageHeader
          title="环境检测"
          desc="面向不同配置的机器，给出本机能做什么、缺什么、怎么补"
          actions={
            <button className="btn-ghost" onClick={scan} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              {loading ? '检测中…' : '重新检测'}
            </button>
          }
        />
      )}

      <div className="space-y-4 px-8 pb-8">
        {error && (
          <div className="rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            检测失败：{error}
          </div>
        )}

        {!report && !loading && !error && (
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-500">
            尚未检测
          </div>
        )}

        {report && (
          <>
            {/* 1 显卡 */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <Cpu size={15} className="text-accent-400" />
                1 · 显卡与生成档位
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-slate-500">显卡</div>
                  <div className="mt-1 text-sm text-slate-200">{gpu?.gpu.name ?? '未检测到'}</div>
                  <div className="text-xs text-slate-500">{gpu?.gpu.driver || '驱动未知'}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">显存</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {gpu?.gpu.vramKnown ? `${(gpu.gpu.vramMB / 1024).toFixed(0)} GB` : '未知'}
                  </div>
                  <div className="text-xs text-slate-500">档位：{gpu?.preset.label ?? '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">视频生成参数</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {gpu?.preset
                      ? `${gpu.preset.video.width}×${gpu.preset.video.height} @ ${gpu.preset.video.frames} 帧`
                      : '—'}
                  </div>
                  <div className="text-xs text-slate-500">{gpu?.preset?.note ?? ''}</div>
                </div>
              </div>
              <div className="mt-3 text-sm">
                模式：
                <span className={mode?.tone ?? 'text-slate-300'}>{mode?.label ?? '—'}</span>
              </div>
            </section>

            {/* 2 ComfyUI */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <ServerCog size={15} className="text-accent-400" />
                  2 · ComfyUI 连接
                </div>
                <button className="btn-ghost" onClick={() => navigate('/settings')}>
                  去设置
                </button>
              </div>
              {comfy?.online ? (
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <CheckCircle2 size={15} />
                  已连接 · v{comfy.version}
                </div>
              ) : (
                <div className="flex items-start gap-2 text-sm text-rose-400">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                  <div>
                    未连接（默认 127.0.0.1:8188）。请先启动 ComfyUI，或在「设置」里填写远程地址。
                    <div className="mt-1 text-xs text-slate-500">
                      本机没有 ComfyUI 时可先使用远程模式，剧本/分镜/导演台功能不受影响。
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* 3 模型库 */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <FolderOpen size={15} className="text-accent-400" />
                3 · 模型库
              </div>
              {!comfy?.online ? (
                <div className="text-sm text-slate-500">启动 ComfyUI 后自动检测可用的 checkpoint / LoRA / VAE。</div>
              ) : (
                <>
                  <div className="flex gap-6 text-sm">
                    <span className="text-slate-300">
                      Checkpoint <b className="text-white">{models?.checkpoints.length ?? 0}</b>
                    </span>
                    <span className="text-slate-300">
                      LoRA <b className="text-white">{models?.loras.length ?? 0}</b>
                    </span>
                    <span className="text-slate-300">
                      VAE <b className="text-white">{models?.vaes.length ?? 0}</b>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(models?.checkpoints ?? []).slice(0, 8).map((m) => (
                      <span key={m} className="rounded bg-white/[0.05] px-2 py-0.5 text-xs text-slate-300">
                        {m}
                      </span>
                    ))}
                    {(models?.checkpoints.length ?? 0) === 0 && (
                      <span className="text-xs text-amber-400">未发现 checkpoint 模型，请把模型放进 ComfyUI 的 models/checkpoints 目录</span>
                    )}
                  </div>
                </>
              )}
            </section>

            {/* 4 结论 */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <Activity size={15} className="text-accent-400" />
                4 · 结论
              </div>
              <ul className="space-y-1.5">
                {(gpu?.recommendations ?? []).map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
                    {r}
                  </li>
                ))}
                <li className="flex items-start gap-2 text-sm text-slate-400">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-600" />
                  ffmpeg：
                  {report.ffmpeg.found ? (
                    <span className="text-slate-300">{report.ffmpeg.version ?? report.ffmpeg.path}</span>
                  ) : (
                    '未检测到（成片拼接功能后续随包提供 ffmpeg）'
                  )}
                </li>
              </ul>
            </section>

            {/* 5 环境安装（下载进度归到每条卡片内） */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <PackagePlus size={15} className="text-accent-400" />
                6 · 环境安装
              </div>
              {catalog.length === 0 ? (
                <div className="text-sm text-slate-500">
                  没有适用于当前显卡的可下载组件（模型目录将在后续版本接入，支持国内镜像与断点续传）。
                </div>
              ) : (
                <div className="space-y-3">
                  {catalog.map((item) => {
                    const idx = sourceIndex[item.id] ?? 0
                    const task = tasks[item.id]
                    const downloading = task?.status === 'downloading' || task?.status === 'queued'
                    const packFiles = item.files ?? []
                    const srcList = packFiles[0]?.sources ?? item.sources ?? []
                    const src = srcList[idx] ?? srcList[0]
                    const installedAll = packFiles.length === 0 ? item.installed : packFiles.every((f) => f.installed)
                    const missing = packFiles.filter((f) => !f.installed).length
                    return (
                      <div key={item.id} className="rounded-lg bg-white/[0.03] px-3 py-3">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <span className="text-slate-200">{item.label}</span>
                            {item.sizeMB ? (
                              <span className="ml-2 text-xs text-slate-500">约 {(item.sizeMB / 1024).toFixed(1)} GB</span>
                            ) : null}
                          </span>
                          {item.kind === 'pack' ? (
                            packFiles.length > 0 ? (
                              <span className={`shrink-0 text-xs ${missing === 0 ? 'text-emerald-400' : missing < packFiles.length ? 'text-amber-400' : 'text-slate-500'}`}>
                                {missing === 0 ? `全部 ${packFiles.length} 项已就绪` : `${packFiles.length - missing}/${packFiles.length} 项已就绪`}
                              </span>
                            ) : null
                          ) : installedAll ? (
                            <span className="flex items-center gap-1 text-xs text-emerald-400">
                              <CheckCircle2 size={13} />
                              已下载
                            </span>
                          ) : null}
                          {installedAll && (
                            <button
                              className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs"
                              onClick={() => {
                                const target = item.files ? (packFiles[0]?.dest ?? item.dest) : item.dest
                                void window.api.openPath(target ? target.replace(/[\\/][^\\/]+$/, '') : '')
                              }}
                            >
                              <FolderOpen size={13} />
                              打开目录
                            </button>
                          )}
                          {!installedAll && !downloading && (
                            <button
                              className="btn-primary shrink-0 !px-3 !py-1.5 text-xs"
                              onClick={() => void downloadItem(item)}
                            >
                              <Download size={13} />
                              下载
                            </button>
                          )}
                          {downloading && (
                            <button className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs" onClick={() => void window.api.downloadCancel(item.id)}>
                              取消
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{item.description}</div>

                        {/* 内联进度条 */}
                        {downloading && (
                          <div className="mt-2">
                            <div className="flex items-center justify-between text-[11px] text-slate-400">
                              <span>{task?.label ?? item.label} 下载中（多线程镜像）</span>
                              <span>{task?.percent ?? 0}%</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                              <div className="h-full bg-accent-500 transition-all" style={{ width: `${task?.percent ?? 0}%` }} />
                            </div>
                            {task?.error && <div className="mt-1 text-xs text-rose-400">{task.error}</div>}
                          </div>
                        )}

                        {/* 工作流包：文件清单 */}
                        {item.kind === 'pack' && packFiles.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {packFiles.map((f) => (
                              <div key={f.file} className="flex items-center gap-2 text-[11px]">
                                <span className={f.installed ? 'text-emerald-400' : 'text-slate-500'}>
                                  {f.installed ? '✓' : '○'}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-slate-400">{f.file}</span>
                                {f.sizeMB ? <span className="text-slate-600">{(f.sizeMB / 1024).toFixed(1)} GB</span> : null}
                              </div>
                            ))}
                          </div>
                        )}

                        {!installedAll && srcList.length > 1 && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-[11px] text-slate-600">下载源</span>
                            <select
                              className="field !w-auto !py-1 text-xs"
                              value={idx}
                              onChange={(e) =>
                                setSourceIndex((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))
                              }
                            >
                              {srcList.map((s, i) => (
                                <option key={s.name} value={i}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* 压缩包解压 */}
                        {item.extract && item.installed && !item.extracted && (
                          <div className="mt-2">
                            <button
                              className="btn-primary shrink-0 !px-3 !py-1.5 text-xs"
                              disabled={extractingId === item.id}
                              onClick={() => void doExtract(item)}
                            >
                              {extractingId === item.id ? '解压中…' : '解压'}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="mt-3 text-[11px] text-slate-600">
                下载为多线程镜像下载，支持断点续传；大文件下载到「用户数据/runtime」或 ComfyUI 的 models 目录，不随应用安装包走。
              </div>
            </section>

            {/* 7 内置 ComfyUI */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <ServerCog size={15} className="text-accent-400" />
                7 · 内置 ComfyUI
              </div>

              {/* 一键安装：自动下载便携版 + 解压 + 配置 + 启动（不含模型） */}
              <div className="mb-4 rounded-lg border border-accent/40 bg-accent-600/[0.08] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">一键安装 ComfyUI（推荐）</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      自动下载官方便携版并解压、配置、启动。约 2.5GB，**不含模型**（模型到下方「模型库/环境安装」按需下载）。
                    </div>
                  </div>
                  <button
                    className="btn-primary shrink-0"
                    disabled={install?.phase === 'downloading' || install?.phase === 'extracting' || install?.phase === 'configuring' || install?.phase === 'starting'}
                    onClick={() => void startOneClickInstall()}
                  >
                    <Download size={14} />
                    一键安装
                  </button>
                </div>
                {install && install.phase !== 'idle' && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className={install.phase === 'error' ? 'text-rose-300' : install.phase === 'done' ? 'text-emerald-300' : 'text-accent-300'}>
                        {install.message}
                      </span>
                      {(install.phase === 'downloading' || install.phase === 'extracting') && (
                        <span className="text-slate-500">{install.percent}%</span>
                      )}
                    </div>
                    {(install.phase === 'downloading' || install.phase === 'extracting') && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full bg-accent-500 transition-all" style={{ width: `${install.percent}%` }} />
                      </div>
                    )}
                    {install.error && install.phase === 'error' && (
                      <div className="mt-1 text-[11px] text-rose-400">{install.error}</div>
                    )}
                  </div>
                )}
              </div>

              {/* 节点包：BanZhang 自定义节点（装完 ComfyUI 后解压到 custom_nodes） */}
              <div className="mb-4 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">BanZhang 节点包（H3 工作流必需）</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      内置节点包，解压到 ComfyUI 的 custom_nodes。装完 ComfyUI 后点这里安装，无需去官网找节点。
                      {nodePack?.installed ? '（已安装）' : ''}
                    </div>
                  </div>
                  <button
                    className="btn-ghost shrink-0"
                    disabled={nodePackBusy || !runtimeRoot.trim()}
                    title={runtimeRoot.trim() ? undefined : '请先填写 ComfyUI 根目录'}
                    onClick={() => void installNodePack()}
                  >
                    <Package size={14} />
                    {nodePackBusy ? '安装中…' : nodePack?.installed ? '重新安装' : '安装节点包'}
                  </button>
                </div>
                {nodePackMsg && <div className="mt-1.5 text-[11px] text-slate-400">{nodePackMsg}</div>}
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    runtimeText[runtime?.status ?? 'missing']?.tone ?? 'text-slate-400'
                  }`}
                >
                  {runtimeText[runtime?.status ?? 'missing']?.label ?? '未知'}
                </span>
                {runtime?.status === 'running' && (
                  <span className="text-xs text-slate-500">
                    pid {runtime.pid} · 端口 {runtime.port}
                  </span>
                )}
                <div className="ml-auto flex gap-2">
                  <button className="btn-ghost" disabled={busy} onClick={refreshRuntime}>
                    <RefreshCw size={14} />
                    刷新
                  </button>
                  {runtime?.status === 'running' ? (
                    <button className="btn-ghost" disabled={busy} onClick={() => void stopRuntime()}>
                      <Square size={14} />
                      停止
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      disabled={busy || !runtime?.root}
                      title={runtime?.root ? undefined : '请先填写 ComfyUI 根目录'}
                      onClick={() => void startRuntime()}
                    >
                      <Play size={14} />
                      启动
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-[1fr_110px_auto] gap-2">
                <div>
                  <label className="label">ComfyUI 根目录（含 main.py 或 ComfyUI\ 子目录）</label>
                  <input
                    className="field"
                    placeholder="例如 E:\ComfyUI (1)"
                    value={runtimeRoot}
                    onChange={(e) => setRuntimeRoot(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">端口</label>
                  <input className="field" value={runtimePort} onChange={(e) => setRuntimePort(e.target.value)} />
                </div>
                <div className="flex items-end">
                  <button className="btn-ghost" onClick={() => void saveRuntimeConfig()}>
                    保存
                  </button>
                </div>
              </div>

              {runtime?.error && <div className="mt-2 text-xs text-rose-400">{runtime.error}</div>}

              {runtime?.status === 'missing' && (
                <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  还没有可用的 ComfyUI：去上方「6 · 环境安装」下载便携版并解压，或填写本机已有的 ComfyUI 根目录后保存。
                </div>
              )}

              {runtime?.logTail && (
                <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-ink-950/70 p-3 font-mono text-[11px] leading-relaxed text-slate-400">
                  {runtime.logTail}
                </pre>
              )}
            </section>

            {/* 8 · 模型搬家（社区/私有模型从已有机器拷贝） */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <FolderOpen size={15} className="text-accent-400" />
                8 · 模型搬家（官网下不到的模型）
              </div>
              <div className="mb-3 text-xs text-slate-500">
                有些模型是社区/私有版本（如 QuadView_krea2_v1、rayQwen21编辑强化、krea2 系 LoRA），官方站点下载不到。
                可在<b className="text-slate-300">有模型的电脑</b>上导出为模型包，再在<b className="text-slate-300">新电脑</b>上导入，
                自动解压到 ComfyUI/models 对应目录。
              </div>
              <div className="mb-2 flex flex-wrap gap-2">
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void loadModels()}>
                  <RefreshCw size={13} />
                  扫描模板引用的模型
                </button>
                <button
                  className="btn-primary !px-3 !py-1.5 text-xs"
                  disabled={modelBusy || !modelList.some((m) => m.exists)}
                  onClick={() => void doExportModels()}
                >
                  <Package size={13} />
                  {modelBusy ? '处理中…' : '导出选中模型'}
                </button>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={modelBusy} onClick={() => void doImportModels()}>
                  <FileUp size={13} />
                  导入模型包
                </button>
                <button
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                  onClick={() => {
                    const all = Object.fromEntries(modelList.filter((m) => m.exists).map((m) => [m.name, true]))
                    setSelectedModels(all)
                  }}
                >
                  全选
                </button>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setSelectedModels({})}>
                  清空
                </button>
              </div>
              {modelMsg && <div className="mb-2 rounded bg-white/[0.04] px-3 py-1.5 text-xs text-slate-300">{modelMsg}</div>}
              {modelList.length === 0 ? (
                <div className="text-xs text-slate-500">点「扫描模板引用的模型」列出当前项目用到的全部模型。</div>
              ) : (
                <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-2">
                  {modelList.map((m) => (
                    <label key={m.name} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-white/[0.04]">
                      <input
                        type="checkbox"
                        disabled={!m.exists}
                        checked={Boolean(selectedModels[m.name])}
                        onChange={(e) => setSelectedModels((prev) => ({ ...prev, [m.name]: e.target.checked }))}
                      />
                      <span className={m.exists ? 'text-slate-300' : 'text-rose-400'}>{m.name}</span>
                      <span className="ml-auto shrink-0 text-slate-500">{m.exists ? m.sizeMB + 'MB' : '缺失'}</span>
                      <span className="w-40 shrink-0 truncate text-slate-600" title={m.relativePath}>{m.relativePath || '-'}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
