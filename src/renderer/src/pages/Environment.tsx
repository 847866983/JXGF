import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, CheckCircle2, Cpu, Download, FolderOpen, PackagePlus, RefreshCw, ServerCog, TriangleAlert } from 'lucide-react'
import type { CatalogItem, DownloadTask, EnvironmentReport } from '@shared/types'
import { PageHeader } from '../components/ui'

const modeText: Record<string, { label: string; tone: string }> = {
  'local-full': { label: '本地全功能（视频+图片）', tone: 'text-emerald-400' },
  'local-image': { label: '本地仅图片', tone: 'text-amber-400' },
  remote: { label: '远程模式', tone: 'text-sky-400' }
}

export default function Environment(): React.JSX.Element {
  const navigate = useNavigate()
  const [report, setReport] = useState<EnvironmentReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [sourceIndex, setSourceIndex] = useState<Record<string, number>>({})
  const [extractingId, setExtractingId] = useState<string | null>(null)

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
      await window.api.envExtract({ archive: item.dest, dest: item.extractedDir })
      refreshCatalog()
    } catch (err) {
      setError(`解压失败：${String((err as Error).message ?? err)}`)
    } finally {
      setExtractingId(null)
    }
  }

  useEffect(() => {
    scan()
    refreshCatalog()
  }, [])

  useEffect(() => {
    void window.api.downloadList().then(setTasks)
    return window.api.onEvent((e) => {
      if (e.type === 'download:state') {
        void window.api.downloadList().then(setTasks)
        refreshCatalog()
      }
    })
  }, [])

  const gpu = report?.gpu
  const comfy = report?.comfy
  const models = report?.models
  const mode = modeText[gpu?.comfyMode ?? 'remote']

  return (
    <div>
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

            {/* 5 下载任务 */}
            <section className="panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                <Download size={15} className="text-accent-400" />
                5 · 下载任务
              </div>
              {tasks.length === 0 ? (
                <div className="text-sm text-slate-500">
                  暂无下载任务。一键下载 ComfyUI 便携版与模型的目录将在后续版本接入此列表（支持断点续传与 SHA256 校验）。
                </div>
              ) : (
                <div className="space-y-3">
                  {tasks.map((t) => (
                    <div key={t.id} className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate text-slate-200">{t.label}</span>
                        <span
                          className={`shrink-0 text-xs ${
                            t.status === 'done'
                              ? 'text-emerald-400'
                              : t.status === 'failed'
                                ? 'text-rose-400'
                                : t.status === 'cancelled'
                                  ? 'text-slate-500'
                                  : 'text-accent-400'
                          }`}
                        >
                          {t.status === 'done'
                            ? '完成'
                            : t.status === 'failed'
                              ? '失败'
                              : t.status === 'cancelled'
                                ? '已取消'
                                : `${t.percent}%`}
                        </span>
                        {(t.status === 'downloading' || t.status === 'queued') && (
                          <button className="btn-ghost shrink-0 !px-2 !py-1 text-xs" onClick={() => void window.api.downloadCancel(t.id)}>
                            取消
                          </button>
                        )}
                      </div>
                      {(t.status === 'downloading' || t.status === 'queued') && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full bg-accent-500 transition-all" style={{ width: `${t.percent}%` }} />
                        </div>
                      )}
                      {t.error && <div className="mt-1 text-xs text-rose-400">{t.error}</div>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 6 环境安装 */}
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
                    const source = item.sources[idx] ?? item.sources[0]
                    return (
                      <div key={item.id} className="rounded-lg bg-white/[0.03] px-3 py-3">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <span className="text-slate-200">{item.label}</span>
                            {item.sizeMB ? (
                              <span className="ml-2 text-xs text-slate-500">约 {(item.sizeMB / 1024).toFixed(1)} GB</span>
                            ) : null}
                          </span>
                          {!item.extract ? (
                            item.installed ? (
                              <>
                                <span className="flex items-center gap-1 text-xs text-emerald-400">
                                  <CheckCircle2 size={13} />
                                  已下载
                                </span>
                                <button
                                  className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs"
                                  onClick={() => void window.api.openPath(item.dest.replace(/[\\/][^\\/]+$/, ''))}
                                >
                                  <FolderOpen size={13} />
                                  打开目录
                                </button>
                              </>
                            ) : (
                              <button
                                className="btn-primary shrink-0 !px-3 !py-1.5 text-xs"
                                onClick={() =>
                                  void window.api.downloadStart({
                                    id: item.id,
                                    label: item.label,
                                    url: source.url,
                                    dest: item.dest
                                  })
                                }
                              >
                                <Download size={13} />
                                下载
                              </button>
                            )
                          ) : item.extracted ? (
                            <>
                              <span className="flex items-center gap-1 text-xs text-emerald-400">
                                <CheckCircle2 size={13} />
                                已解压
                              </span>
                              <button
                                className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs"
                                onClick={() => void window.api.openPath(item.extractedDir)}
                              >
                                <FolderOpen size={13} />
                                打开目录
                              </button>
                            </>
                          ) : item.installed ? (
                            <>
                              <span className="flex items-center gap-1 text-xs text-emerald-400">
                                <CheckCircle2 size={13} />
                                已下载
                              </span>
                              <button
                                className="btn-primary shrink-0 !px-3 !py-1.5 text-xs"
                                disabled={extractingId === item.id}
                                onClick={() => void doExtract(item)}
                              >
                                {extractingId === item.id ? '解压中…' : '解压'}
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn-primary shrink-0 !px-3 !py-1.5 text-xs"
                              onClick={() =>
                                void window.api.downloadStart({
                                  id: item.id,
                                  label: item.label,
                                  url: source.url,
                                  dest: item.dest
                                })
                              }
                            >
                              <Download size={13} />
                              下载
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{item.description}</div>
                        {!item.installed && item.sources.length > 1 && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-[11px] text-slate-600">下载源</span>
                            <select
                              className="field !w-auto !py-1 text-xs"
                              value={idx}
                              onChange={(e) =>
                                setSourceIndex((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))
                              }
                            >
                              {item.sources.map((s, i) => (
                                <option key={s.name} value={i}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="mt-3 text-[11px] text-slate-600">
                下载使用断点续传，失败后可直接重新点击继续；大文件下载到「用户数据/runtime」目录，不随应用安装包走。
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
