import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GpuInfo, GpuVendor } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * 读取 NVIDIA 显卡的真实显存占用（MB）。
 * 用途：ComfyUI system_stats 在 cudaMallocAsync 模式下 vram_free/torch_vram_* 会上报 0
 * （并非真的占满），状态卡片若据此计算会误显示 100%。nvidia-smi 是所有进程占用的权威来源。
 * 返回 null 表示不可用（无 N 卡 / 命令失败），调用方应回退到 ComfyUI 上报值。
 */
export async function nvidiaVramUsage(): Promise<{ usedMB: number; totalMB: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }
    )
    const line = stdout.trim().split(/\r?\n/)[0]
    if (!line) return null
    const parts = line.split(',').map((s) => s.trim())
    const usedMB = Number(parts[0])
    const totalMB = Number(parts[1])
    if (!Number.isFinite(usedMB) || !Number.isFinite(totalMB) || totalMB <= 0) return null
    return { usedMB, totalMB }
  } catch {
    return null
  }
}

function classify(name: string): GpuVendor {
  const n = name.toLowerCase()
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('gtx') || n.includes('quadro')) {
    return 'nvidia'
  }
  if (n.includes('amd') || n.includes('radeon')) return 'amd'
  if (n.includes('intel') || n.includes('arc') || n.includes('iris')) return 'intel'
  return 'unknown'
}

async function viaNvidiaSmi(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 8000, windowsHide: true }
    )
    const line = stdout.trim().split(/\r?\n/)[0]
    if (!line) return null
    const parts = line.split(',').map((s) => s.trim())
    const name = parts[0] ?? 'NVIDIA GPU'
    const vramMB = Number(parts[1] ?? 0)
    return {
      vendor: 'nvidia',
      name,
      vramMB: Number.isFinite(vramMB) ? vramMB : 0,
      vramKnown: Number.isFinite(vramMB) && vramMB > 0,
      driver: parts[2] ?? '',
      cudaAvailable: vramMB > 0,
      raw: line
    }
  } catch {
    return null
  }
}

async function viaWmi(): Promise<GpuInfo | null> {
  try {
    const ps =
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15000, windowsHide: true }
    )
    if (!stdout.trim()) return null
    const parsed: unknown = JSON.parse(stdout)
    const list: Array<Record<string, unknown>> = Array.isArray(parsed) ? (parsed as []) : [parsed as Record<string, unknown>]
    // 优先取显存非空（且非 0）的适配器
    const pick =
      list.find((g) => Number(g.AdapterRAM ?? 0) > 0) ??
      list.find((g) => typeof g.Name === 'string' && (g.Name as string).length > 0) ??
      list[0]
    if (!pick) return null
    const name = String(pick.Name ?? '未知显卡')
    const rawVRAM = Number(pick.AdapterRAM ?? 0)
    // Win32_VideoController.AdapterRAM 是 UInt32 字节数，超过 4GB 会溢出为 4294967295
    const vramMB = rawVRAM > 0 && rawVRAM < 4 * 1024 * 1024 * 1024 ? Math.round(rawVRAM / 1024 / 1024) : 0
    return {
      vendor: classify(name),
      name,
      vramMB,
      vramKnown: vramMB > 0,
      driver: String(pick.DriverVersion ?? ''),
      cudaAvailable: false,
      raw: JSON.stringify(pick)
    }
  } catch {
    return null
  }
}

export async function detectGpu(): Promise<GpuInfo> {
  const nvidia = await viaNvidiaSmi()
  if (nvidia) return nvidia
  const wmi = await viaWmi()
  if (wmi) return wmi
  return {
    vendor: 'unknown',
    name: '未检测到独立显卡',
    vramMB: 0,
    vramKnown: false,
    driver: '',
    cudaAvailable: false,
    raw: ''
  }
}
