/**
 * 镜像改写纯逻辑（不依赖 electron，便于 Node 自测）。
 * 网络设置的读写与代理在 network.ts。
 */
import type { NetworkSettings } from '@shared/types'

export const DEFAULT_NETWORK: NetworkSettings = {
  proxyAddress: '',
  mirrorPypi: true,
  mirrorGit: true,
  mirrorHuggingface: true,
  mirrorExtensionList: true,
  githubAcceleration: true
}

/**
 * 把镜像开关应用到下载源列表。
 * - githubAcceleration：github.com 链接自动加 gh-proxy 加速前缀
 * - mirrorHuggingface：huggingface.co 链接改写为 hf-mirror.com
 */
export function applyMirrors<T extends { name: string; url: string }>(
  sources: T[],
  net?: NetworkSettings
): T[] {
  const n = net ?? DEFAULT_NETWORK
  const out: T[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    let url = s.url
    if (n.githubAcceleration && /^https:\/\/github\.com/i.test(url) && !/gh-proxy\.com/i.test(url)) {
      url = `https://gh-proxy.com/${url}`
    }
    if (n.mirrorHuggingface && /^https:\/\/huggingface\.co/i.test(url)) {
      url = url.replace(/^https:\/\/huggingface\.co/i, 'https://hf-mirror.com')
    }
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ ...s, url })
  }
  return out
}
