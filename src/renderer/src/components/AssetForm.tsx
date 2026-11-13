import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Asset, AssetKind } from '@shared/types'
import { kindLabel } from './badges'

export interface AssetFormData {
  name: string
  kind: AssetKind
  alias: string
  tags: string[]
  description: string
  prompt: string
  negative: string
}

const kinds: AssetKind[] = ['character', 'scene', 'prop']

function parseTags(text: string): string[] {
  return text
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function AssetForm({
  initial,
  submitId,
  onSubmit
}: {
  initial: Asset | null
  submitId?: string
  onSubmit: (data: AssetFormData) => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<AssetKind>(initial?.kind ?? 'character')
  const [alias, setAlias] = useState(initial?.alias ?? '')
  const [tagsText, setTagsText] = useState(initial?.tags.join(', ') ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [negative, setNegative] = useState(initial?.negative ?? '')

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    onSubmit({
      name: name.trim(),
      kind,
      alias: alias.trim(),
      tags: parseTags(tagsText),
      description,
      prompt,
      negative
    })
  }

  return (
    <form id={submitId} onSubmit={submit} className="space-y-4">
      <div>
        <label className="label">名称 *</label>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：沈砚"
          autoFocus
        />
      </div>

      <div>
        <label className="label">类型</label>
        <div className="flex gap-2">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                kind === k
                  ? 'border-accent/60 bg-accent-600/15 text-accent-400'
                  : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'
              }`}
            >
              {kindLabel[k]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">别名</label>
        <input
          className="field"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="可留空"
        />
      </div>

      <div>
        <label className="label">标签（逗号分隔）</label>
        <input
          className="field"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="男主, 清冷, 民国"
        />
      </div>

      <div>
        <label className="label">描述</label>
        <textarea
          className="field min-h-[64px] resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div>
        <label className="label">正面提示词 prompt</label>
        <textarea
          className="field min-h-[80px] resize-y"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div>
        <label className="label">负面提示词 negative</label>
        <textarea
          className="field min-h-[64px] resize-y"
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
        />
      </div>
    </form>
  )
}
