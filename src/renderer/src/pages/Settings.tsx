import { useEffect, useState } from 'react'
import { Copy, Download, Play, Plug, RefreshCw, RotateCw, Save, ShieldCheck, Square } from 'lucide-react'
import type { ComfySettings } from '@shared/types'
import { useApp } from '../store/app'
import { PageHeader } from '../components/ui'
import { NodeCatalogPanel } from '../components/NodeCatalogPanel'

const DEFAULT_COMFY: ComfySettings = { host: '127.0.0.1', port: 8188, protocol: 'http' }

export default function Settings(): React.JSX.Element {
  const comfy = useApp((s) => s.comfy)
  const comfyRuntime = useApp((s) => s.comfyRuntime)
  const refreshComfyRuntime = useApp((s) => s.refreshComfyRuntime)
  const update = useApp((s) => s.update)
  const project = useApp((s) => s.project)
  const refreshComfy = useApp((s) => s.refreshComfy)
  const testComfy = useApp((s) => s.testComfy)
  const saveProject = useApp((s) => s.saveProject)
  const loadUpdate = useApp((s) => s.loadUpdate)

  const saved = project?.settings.comfy ?? DEFAULT_COMFY
  const [host, setHost] = useState(saved.host)
  const [port, setPort] = useState(String(saved.port))
  const [protocol, setProtocol] = useState<'http' | 'https'>(saved.protocol)
  const [savedFlag, setSavedFlag] = useState(false)
  /** ComfyUI 运行时：根目录 / 端口 / 操作忙碌 / 错误提示 */
  const [runtimeRoot, setRuntimeRoot] = useState('')
  const [runtimePort, setRuntimePort] = useState('8188')
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  // 运行时状态变化时同步输入框（首次 / 启动停止后）
  useEffect(() => {
    if (!comfyRuntime) return
    setRuntimeRoot(comfyRuntime.root ?? '')
    setRuntimePort(String(comfyRuntime.port ?? 8188))
  }, [comfyRuntime?.root, comfyRuntime?.port])
  const [testResult, setTestResult] = useState<{ ok: boolean; version: string; error: string | null } | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [mcp, setMcp] = useState<{
    command: string
    args: string[]
    env: Record<string, string>
    script: string
    projectsDir: string
    note: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.api.appInfo().then((info) => setMcp(info.mcp))
  }, [])

  useEffect(() => {
    setHost(saved.host)
    setPort(String(saved.port))
    setProtocol(saved.protocol)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  useEffect(() => {
    void refreshComfy()
    void loadUpdate()
  }, [refreshComfy, loadUpdate])

  const runTest = (): void => {
    setTestResult(null)
    void testComfy({ host: host.trim() || '127.0.0.1', port: Number(port) || 8188, protocol }).then(setTestResult)
  }

  const saveComfy = async (): Promise<void> => {
    // 基于主进程最新快照改，避免闭包里的旧 project 整份覆盖掉后台写回的产物
    const latest = await window.api.projectGetCurrent()
    if (!latest) return
    const next = {
      ...latest,
      settings: {
        ...latest.settings,
        comfy: { host: host.trim() || '127.0.0.1', port: Number(port) || 8188, protocol }
      }
    }
    await saveProject(next)
    setSavedFlag(true)
    setTimeout(() => setSavedFlag(false), 2000)
  }

  /** 保存 ComfyUI 根目录 / 端口（runtime.json，独立于连接配置） */
  const saveRuntimeConfig = async (): Promise<void> => {
    setRuntimeError(null)
    try {
      const st = await window.api.comfyRuntimeSetConfig({
        root: runtimeRoot.trim() || null,
        port: Number(runtimePort) || 8188,
        python: null
      })
      await refreshComfyRuntime()
      // 让"测试连接/生成"用的端口与运行时端口保持一致
      if (String(st.port) !== port) {
        setPort(String(st.port))
        await window.api.projectGetCurrent().then(async (latest) => {
          if (!latest) return
          await saveProject({
            ...latest,
            settings: { ...latest.settings, comfy: { ...latest.settings.comfy, port: st.port } }
          })
        })
      }
      setSavedFlag(true)
      setTimeout(() => setSavedFlag(false), 2000)
    } catch (err) {
      setRuntimeError(`保存路径失败：${String((err as Error).message ?? err)}`)
    }
  }

  const startRuntime = async (): Promise<void> => {
    setRuntimeBusy(true)
    setRuntimeError(null)
    try {
      await window.api.comfyRuntimeStart()
      await refreshComfyRuntime()
      await refreshComfy()
    } catch (err) {
      setRuntimeError(`启动失败：${String((err as Error).message ?? err)}`)
    } finally {
      setRuntimeBusy(false)
    }
  }

  const stopRuntime = async (): Promise<void> => {
    setRuntimeBusy(true)
    setRuntimeError(null)
    try {
      await window.api.comfyRuntimeStop()
      await refreshComfyRuntime()
      await refreshComfy()
    } catch (err) {
      setRuntimeError(`停止失败：${String((err as Error).message ?? err)}`)
    } finally {
      setRuntimeBusy(false)
    }
  }

  const downloadUpdate = (): void => {
    setDownloading(true)
    void window.api
      .updateDownload()
      .then((info) => {
        useApp.setState({ update: info })
      })
      .finally(() => setDownloading(false))
  }

  const checkUpdate = (): void => {
    setChecking(true)
    void window.api.updateCheck().then((info) => {
      useApp.setState({ update: info })
      setChecking(false)
    })
  }


  /** 设置内容分类 */
  const ComfyConn = (
    <div className="panel p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
        <ShieldCheck size={15} className="text-accent-400" />
        ComfyUI 连接
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_110px_auto] gap-2">
          <div>
            <label className="label">地址</label>
            <input className="field" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
          </div>
          <div>
            <label className="label">端口</label>
            <input className="field" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8188" />
          </div>
          <div>
            <label className="label">协议</label>
            <select
              className="field"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as 'http' | 'https')}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">状态</span>
          <span className={comfy?.online ? 'text-emerald-400' : 'text-rose-400'}>
            {comfy?.online ? `已连接 · v${comfy.version}` : '未连接'}
          </span>
        </div>

        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => void refreshComfy()}>
            <RefreshCw size={15} />
            刷新
          </button>
          <button className="btn-primary" onClick={runTest}>
            <RotateCw size={15} />
            测试连接
          </button>
          <button className="btn-ghost" disabled={!project} onClick={() => void saveComfy()}>
            <Save size={15} />
            {savedFlag ? '已保存' : '保存'}
          </button>
        </div>

        {!project && <div className="text-xs text-slate-500">需要打开项目后才能保存连接配置</div>}
        {testResult && (
          <div
            className={`rounded-lg px-3 py-2.5 text-sm ${
              testResult.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
            }`}
          >
            {testResult.ok ? `连接成功，ComfyUI v${testResult.version}` : testResult.error}
          </div>
        )}

        {/* 本机 ComfyUI 运行时：路径 + 启动/停止（与上面的连接配置相互独立） */}
        <div className="border-t border-white/10 pt-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
            本机 ComfyUI
            {(() => {
              const s = comfyRuntime?.status ?? 'missing'
              const map: Record<string, { label: string; tone: string }> = {
                missing: { label: '未安装', tone: 'text-slate-400' },
                installed: { label: '已安装（未运行）', tone: 'text-amber-400' },
                starting: { label: '启动中…', tone: 'text-accent-400' },
                running: { label: '运行中', tone: 'text-emerald-400' },
                stopped: { label: '已停止', tone: 'text-slate-400' },
                error: { label: '出错', tone: 'text-rose-400' }
              }
              const m = map[s] ?? map.missing
              return <span className={`rounded bg-white/5 px-2 py-0.5 text-[11px] ${m.tone}`}>{m.label}</span>
            })()}
            {comfyRuntime?.status === 'running' && (
              <span className="text-[11px] text-slate-500">pid {comfyRuntime.pid} · 端口 {comfyRuntime.port}</span>
            )}
          </div>
          <div className="grid grid-cols-[1fr_110px_auto] gap-2">
            <div>
              <label className="label">ComfyUI 路径（含 main.py 或 ComfyUI\ 子目录）</label>
              <input
                className="field"
                placeholder="例如 E:\ComfyUI"
                value={runtimeRoot}
                onChange={(e) => setRuntimeRoot(e.target.value)}
              />
            </div>
            <div>
              <label className="label">端口</label>
              <input className="field" value={runtimePort} onChange={(e) => setRuntimePort(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <button className="btn-ghost" onClick={() => void saveRuntimeConfig()} title="保存路径与端口">
                <Save size={15} />
              </button>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            {comfyRuntime?.status === 'running' ? (
              <button className="btn-ghost" disabled={runtimeBusy} onClick={() => void stopRuntime()}>
                <Square size={15} /> 停止
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={runtimeBusy || !runtimeRoot.trim()}
                title={runtimeRoot.trim() ? undefined : '请先填写并保存 ComfyUI 路径'}
                onClick={() => void startRuntime()}
              >
                <Play size={15} /> 启动
              </button>
            )}
            <button className="btn-ghost" disabled={runtimeBusy} onClick={() => void refreshComfyRuntime()}>
              <RefreshCw size={15} /> 刷新状态
            </button>
          </div>
          {runtimeError && <div className="mt-2 text-xs text-rose-400">{runtimeError}</div>}
          {comfyRuntime?.status === 'missing' && (
            <div className="mt-2 text-xs text-amber-300">
              还没找到 ComfyUI：可填上面的路径并保存，或让软件自动检测（启动时会检测一次）。
            </div>
          )}
          {comfyRuntime?.logTail && (
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-ink-950/70 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
              {comfyRuntime.logTail}
            </pre>
          )}
        </div>
      </div>
    </div>
  )

  const McpPanel = (
    <div className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <Plug size={15} className="text-accent-400" />
          MCP 接入（AI 助手调用）
        </div>
        {mcp && (
          <button
            className="btn-ghost"
            onClick={() => {
              const cfg = {
                mcpServers: {
                  'jingxu-studio': {
                    command: mcp.command,
                    args: mcp.args,
                    env: { JXGF_PROJECTS: mcp.projectsDir }
                  }
                }
              }
              void navigator.clipboard.writeText(JSON.stringify(cfg, null, 2)).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
            }}
          >
            <Copy size={14} />
            {copied ? '已复制' : '复制配置 JSON'}
          </button>
        )}
      </div>

      <div className="mb-3 text-xs text-slate-500">
        让豆包 / DeepSeek Harness / Claude 等 AI 助手直接读写剧本分镜与资产管理。把下面的配置粘贴到 AI 客户端的「MCP 服务器」设置里（stdio 类型）。
      </div>

      {!mcp ? (
        <div className="text-sm text-slate-500">读取中…</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            ✅ {mcp.note}——换电脑安装本软件后，此处配置自动适配，无需手动改路径。
          </div>
          <div className="grid grid-cols-1 gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-slate-500">启动命令</span>
              <code className="min-w-0 flex-1 truncate rounded bg-ink-950/60 px-2 py-1 text-xs text-slate-300">
                {mcp.command}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-slate-500">服务器脚本</span>
              <code className="min-w-0 flex-1 truncate rounded bg-ink-950/60 px-2 py-1 text-xs text-slate-300">
                {mcp.script}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-slate-500">项目目录</span>
              <code className="min-w-0 flex-1 truncate rounded bg-ink-950/60 px-2 py-1 text-xs text-slate-300">
                {mcp.projectsDir}
              </code>
            </div>
          </div>

          <pre className="max-h-56 overflow-auto rounded-lg bg-ink-950/70 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
{JSON.stringify(
  {
    mcpServers: {
      'jingxu-studio': {
        command: mcp.command,
        args: mcp.args,
        env: mcp.env
      }
    }
  },
  null,
  2
)}
          </pre>

          <div className="text-[11px] text-slate-600">
            提供的工具：list_projects / create_asset / update_asset / create_script / create_episode /
            create_scene / create_shot / add_shots（批量）/ list_shots / get_shot / update_shot（含 prompt 提示词）/ update_segment（分段参数）/ 记忆库 / H3 技能 等共 23 个。
            详见 docs/MCP接入指南.md。
          </div>
        </div>
      )}
    </div>
  )

  // 网络与下载源设置（对齐绘世启动器的网络设置面板）
  const AboutPanel = (
    <div className="panel p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
        <Download size={15} className="text-accent-400" />
        关于与更新
      </div>
      <div className="mb-4 space-y-2 text-sm text-slate-300">
        <div className="flex justify-between">
          <span className="text-slate-500">当前版本</span>
          <span className="text-slate-200">{update?.currentVersion ?? '—'}</span>
        </div>
        {update?.available && (
          <div className="flex justify-between">
            <span className="text-slate-500">发现新版本</span>
            <span className="text-accent-400">{update.version}</span>
          </div>
        )}
        {typeof update?.percent === 'number' && update.percent > 0 && !update.downloaded && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-400">
              <span>正在下载更新…</span>
              <span>{update.percent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-accent-500 transition-all" style={{ width: `${update.percent}%` }} />
            </div>
          </div>
        )}
        {update?.downloaded && (
          <div className="rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            更新已下载完成（{update.version}），点下方按钮重启安装
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" disabled={checking} onClick={checkUpdate}>
          <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
          {checking ? '检查中…' : '检查更新'}
        </button>
        {update?.available && !update.downloaded && (
          <button className="btn-primary" disabled={downloading} onClick={downloadUpdate}>
            <Download size={15} className={downloading ? 'animate-pulse' : ''} />
            {downloading ? '下载中…' : '下载更新'}
          </button>
        )}
        {update?.downloaded && (
          <button className="btn-primary" onClick={() => void window.api.updateInstall()}>
            重启并安装
          </button>
        )}
      </div>
      {update?.error && <div className="mt-3 text-xs text-rose-400">更新出错：{update.error}</div>}
      {!update?.error && !update?.available && update?.releaseNotes && (
        <div className="mt-3 text-xs text-slate-500">{update.releaseNotes}</div>
      )}
    </div>
  )


  return (
    <div>
      <PageHeader title="设置" desc="ComfyUI 连接、节点能力、MCP 接入与更新" />

      <div className="px-8 pb-8 space-y-4">
        {/* 一、ComfyUI 连接 */}
        <section>
          <div className="mb-2 text-xs font-medium text-slate-500">一 · ComfyUI 连接</div>
          {ComfyConn}
        </section>

        {/* 二、节点能力总览 */}
        <section>
          <div className="mb-2 text-xs font-medium text-slate-500">二 · 节点能力总览</div>
          <NodeCatalogPanel />
        </section>

        {/* 三、MCP 接入（AI 助手调用） */}
        <section>
          <div className="mb-2 text-xs font-medium text-slate-500">三 · MCP 接入</div>
          {McpPanel}
        </section>

        {/* 四、关于与更新 */}
        <section>
          <div className="mb-2 text-xs font-medium text-slate-500">四 · 关于与更新</div>
          {AboutPanel}
        </section>
      </div>
    </div>
  )
}
