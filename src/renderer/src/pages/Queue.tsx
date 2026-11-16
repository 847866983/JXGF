import { useEffect } from 'react'
import { Ban, Film, Image, RotateCw } from 'lucide-react'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'
import { explainError } from '../lib/errorHelp'

const statusText: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const statusTone: Record<string, string> = {
  queued: 'text-slate-300 bg-white/5',
  running: 'text-accent-400 bg-accent-600/10',
  done: 'text-emerald-400 bg-emerald-500/10',
  failed: 'text-rose-400 bg-rose-500/10',
  cancelled: 'text-slate-500 bg-white/5'
}

export default function Queue(): React.JSX.Element {
  const jobs = useApp((s) => s.jobs)
  const refreshJobs = useApp((s) => s.refreshJobs)

  useEffect(() => {
    void refreshJobs()
  }, [refreshJobs])

  const retry = async (jobId: string): Promise<void> => {
    try {
      await window.api.jobRetry(jobId)
      await refreshJobs()
    } catch (err) {
      console.error('重试失败', err)
    }
  }

  return (
    <div>
      <PageHeader title="生成队列" desc="本地任务提交、进度与产物归档" />
      <div className="space-y-3 px-8 pb-8">
        {jobs.length === 0 ? (
          <EmptyState title="队列为空" desc="在导演台或剧本分镜里提交生成任务后会出现在这里" />
        ) : (
          jobs.map((job) => {
            const help = job.status === 'failed' ? explainError(job.error) : null
            return (
              <div key={job.id} className="panel p-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.04] text-accent-400">
                    {job.kind === 'video' ? <Film size={18} /> : <Image size={18} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{job.kind === 'video' ? '视频生成' : '图片生成'}</span>
                      <span className={`rounded px-2 py-0.5 text-xs ${statusTone[job.status]}`}>
                        {statusText[job.status] ?? job.status}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">{job.promptId ?? job.id}</div>
                    {job.status === 'running' && (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full bg-accent-500 transition-all" style={{ width: `${job.progress}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{job.outputs.length} 个产物</div>
                  {(job.status === 'queued' || job.status === 'running') && (
                    <button className="btn-ghost" onClick={() => void window.api.jobCancel(job.id)}>
                      <Ban size={14} />
                      取消
                    </button>
                  )}
                  {job.status === 'failed' && (
                    <button className="btn-primary" onClick={() => void retry(job.id)}>
                      <RotateCw size={14} />
                      重试
                    </button>
                  )}
                </div>

                {job.status === 'failed' && (
                  <div className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm">
                    <div className="font-medium text-rose-300">⚠ {help?.reason ?? '生成失败'}</div>
                    {help?.suggestion && <div className="mt-1 text-xs text-rose-200/80">建议：{help.suggestion}</div>}
                    {job.error && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-400">查看原始错误</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-slate-400">
                          {job.error}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
                {job.status === 'queued' && job.error && (
                  <div className="mt-2 text-xs text-amber-400/80">{job.error}</div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
