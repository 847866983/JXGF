import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Copy, Download, FileUp, Plug, RefreshCw, RotateCw, Save, ShieldCheck, Workflow } from 'lucide-react'
import type { ComfySettings } from '@shared/types'
import { useApp } from '../store/app'
import { PageHeader } from '../components/ui'

const DEFAULT_COMFY: ComfySettings = { host: '127.0.0.1', port: 8188, protocol: 'http' }

export default function Settings(): React.JSX.Element {
  const comfy = useApp((s) => s.comfy)
  const update = useApp((s) => s.update)
  const project = useApp((s) => s.project)
  const refreshComfy = useApp((s) => s.refreshComfy)
  const testComfy = useApp((s) => s.testComfy)
  const saveProject = useApp((s) => s.saveProject)
  const importTemplate = useApp((s) => s.importTemplate)
  const loadUpdate = useApp((s) => s.loadUpdate)

  const saved = project?.settings.comfy ?? DEFAULT_COMFY
  const [host, setHost] = useState(saved.host)
  const [port, setPort] = useState(String(saved.port))
  const [protocol, setProtocol] = useState<'http' | 'https'>(saved.protocol)
  const [savedFlag, setSavedFlag] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; version: string; error: string | null } | null>(null)
  const [checking, setChecking] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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
    if (!project) return
    const next = {
      ...project,
      settings: {
        ...project.settings,
        comfy: { host: host.trim() || '127.0.0.1', port: Number(port) || 8188, protocol }
      }
    }
    await saveProject(next)
    setSavedFlag(true)
    setTimeout(() => setSavedFlag(false), 2000)
  }

  const checkUpdate = (): void => {
    setChecking(true)
    void window.api.updateCheck().then((info) => {
      useApp.setState({ update: info })
      setChecking(false)
    })
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    try {
      const text = await file.text()
      const json: unknown = JSON.parse(text)
      // 兼容两种格式：UI 格式（nodes/links）会在主进程自动转 API；API 格式直接导入
      const name = file.name.replace(/\.json$/i, '') || '未命名工作流'
      const isUi = Boolean((json as { nodes?: unknown }).nodes && (json as { links?: unknown }).links)
      // kind 交给主进程自动判定（UI 格式转换后判定，API 格式直接判定）
      await importTemplate(name, undefined, json)
      setImportError(null)
      void isUi
    } catch (err) {
      setImportError(`导入失败：${String((err as Error).message ?? err)}`)
    }
  }

  const templates = project?.templates ?? []

  return (
    <div>
      <PageHeader title="设置" desc="运行环境、ComfyUI 连接、工作流模板与在线更新" />

      <div className="grid grid-cols-2 gap-4 px-8">
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
          </div>
        </div>

        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
            <Download size={15} className="text-accent-400" />
            在线更新
          </div>
          <div className="mb-4 space-y-2 text-sm text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-500">当前版本</span>
              <span>{update?.version ?? '—'}</span>
            </div>
            {update?.available && (
              <div className="flex justify-between">
                <span className="text-slate-500">可用版本</span>
                <span className="text-accent-400">{update.version}</span>
              </div>
            )}
            {typeof update?.percent === 'number' && update.percent > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-accent-500" style={{ width: `${update.percent}%` }} />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={checking} onClick={checkUpdate}>
              <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
              检查更新
            </button>
            {update?.downloaded && (
              <button className="btn-primary" onClick={() => void window.api.updateInstall()}>
                重启并安装
              </button>
            )}
          </div>
          {update?.error && <div className="mt-3 text-xs text-rose-400">{update.error}</div>}
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="panel mt-4 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Workflow size={15} className="text-accent-400" />
              工作流模板
            </div>
            <button
              className="btn-primary"
              disabled={!project}
              onClick={() => fileRef.current?.click()}
              title={project ? undefined : '请先打开项目'}
            >
              <FileUp size={15} />
              导入工作流
            </button>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => void onFile(e)} />
          </div>

          <div className="mb-2 text-xs text-slate-500">
            支持 ComfyUI 界面格式（含 nodes/links）与「导出（API）」格式；界面格式会自动转换为 API 格式。需 ComfyUI 在线。
          </div>

          {importError && (
            <div className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{importError}</div>
          )}

          {templates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
              {project ? '还没有模板，点击右上角「导入工作流」' : '请先打开项目，再导入工作流'}
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      t.kind === 'video' ? 'bg-accent-600/15 text-accent-400' : 'bg-emerald-500/10 text-emerald-400'
                    }`}
                  >
                    {t.kind === 'video' ? '视频' : '图片'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{t.name}</span>
                  <span className="text-[11px] text-slate-500">{t.id.slice(0, 12)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MCP 接入 */}
      <div className="px-8 pb-8">
        <div className="panel mt-4 p-5">
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
                create_scene / create_shot / add_shots（批量）/ list_shots / update_shot 等共 13 个。
                详见 docs/MCP接入指南.md。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
