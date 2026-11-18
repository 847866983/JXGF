/**
 * 网络与镜像设置
 *
 * 逻辑对齐绘世启动器（ComfyUI-aki-v3）的 network_preference：
 *   proxy_address / mirror_pypi / mirror_git / mirror_huggingface /
 *   mirror_extension_list / github_acceleration
 *
 * 本软件通过 Electron 主进程的 undici ProxyAgent 全局代理，
 * 下载源列表按开关做镜像改写（GitHub 加速 / HuggingFace 镜像，见 network-mirrors）。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import type { NetworkSettings } from '@shared/types'
import { DEFAULT_NETWORK, applyMirrors } from './network-mirrors'

export type { NetworkSettings }
export { DEFAULT_NETWORK, applyMirrors }

let cached: NetworkSettings | null = null
let proxyAgent: Agent | ProxyAgent | null = null

function netPath(): string {
  return path.join(app.getPath('userData'), 'network.json')
}

/** 读取设置（首次读取即应用代理） */
export function loadNetworkSettings(): NetworkSettings {
  let raw = ''
  try {
    raw = fs.readFileSync(netPath(), 'utf8')
  } catch {
    raw = ''
  }
  if (raw) {
    try {
      cached = { ...DEFAULT_NETWORK, ...(JSON.parse(raw) as Partial<NetworkSettings>) }
    } catch {
      cached = { ...DEFAULT_NETWORK }
    }
  } else {
    cached = { ...DEFAULT_NETWORK }
  }
  applyProxy(cached.proxyAddress)
  return cached
}

export function getNetworkSettings(): NetworkSettings {
  if (!cached) return loadNetworkSettings()
  return cached
}

/** 保存部分设置并立即生效 */
export function saveNetworkSettings(patch: Partial<NetworkSettings>): NetworkSettings {
  const cur = getNetworkSettings()
  cached = { ...cur, ...patch }
  try {
    fs.writeFileSync(netPath(), JSON.stringify(cached, null, 2), 'utf8')
  } catch {
    // 忽略写入失败，内存中已生效
  }
  applyProxy(cached.proxyAddress)
  return cached
}

/** 应用全局代理；空地址重置为直连。代理地址非法时保持直连，不阻断下载。 */
export function applyProxy(proxyAddress: string): void {
  try {
    if (proxyAddress) {
      if (!(proxyAgent instanceof ProxyAgent)) {
        proxyAgent?.close().catch(() => undefined)
        proxyAgent = new ProxyAgent(proxyAddress)
      }
      setGlobalDispatcher(proxyAgent)
    } else if (proxyAgent) {
      proxyAgent.close().catch(() => undefined)
      proxyAgent = new Agent()
      setGlobalDispatcher(proxyAgent)
    }
  } catch {
    // 代理地址非法时保持直连
  }
}
