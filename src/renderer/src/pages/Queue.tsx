import { useEffect } from 'react'
import { Ban, Film, Image } from 'lucide-react'
import { useApp } from '../store/app'
import { EmptyState, PageHeader } from '../components/ui'

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

  return (
    <div>
      <PageHeader title="生成队列" desc="本地任务提交、进度与产物归档" />
      <div className="space-y-3 px-8 pb-8">
        {jobs.length === 0 ? (
          <EmptyState title="队列为空" desc="在导演台或剧本分镜里提交生成任务后会出现在这里" />
        ) : (
          jobs.map((job) => (
            <div key={job.id} className="panel flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.04] text-accent-400">
                {job.kind === 'video' ? <Film size={18} /> : <Image size={18} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">
                    {job.kind === 'video' ? '视频生成' : '图片生成'}
                  </span>
                  <span className={`rounded px-2 py-0.5 text-xs ${statusTone[job.status]}`}>
                    {statusText[job.status] ?? job.status}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {job.promptId ?? job.id}
                  {job.error ? ` · ${job.error}` : ''}
                </div>
                {job.status === 'running' && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-accent-500 transition-all"
                      style={{ width: `${job.progress}%` }}
                    />
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
            </div>
          ))
        )}
      </div>
    </div>
  )
}
