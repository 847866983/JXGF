import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'

type Emit = (payload: { type: 'update:state'; info: UpdateInfo }) => void

/**
 * 在线自动更新：基于 electron-updater。
 * 发布到 GitHub Releases（见 electron-builder.yml 的 publish 段）。
 * 在开发模式（未打包）下自动禁用，避免干扰调试。
 */
export class Updater {
  private current: UpdateInfo = { available: false }
  private emit: Emit | null = null
  private listenersBound = false

  constructor() {
    this.current = {
      available: false,
      version: app.getVersion(),
      releaseNotes: app.isPackaged ? '' : '开发模式：自动更新未启用'
    }
  }

  setEmitter(emit: Emit): void {
    this.emit = emit
  }

  getInfo(): UpdateInfo {
    return this.current
  }

  private set(info: Partial<UpdateInfo>): void {
    this.current = { ...this.current, ...info }
    this.emit?.({ type: 'update:state', info: this.current })
  }

  async check(): Promise<UpdateInfo> {
    if (!app.isPackaged) {
      this.set({ available: false, releaseNotes: '开发模式：自动更新未启用（打包后生效）' })
      return this.current
    }
    try {
      const autoUpdater = (await this.loadAutoUpdater()) as any
      if (!autoUpdater) {
        this.set({ available: false, error: '自动更新组件未加载（electron-updater 未正确打包）' })
        return this.current
      }
      if (!this.listenersBound) {
        this.listenersBound = true
        autoUpdater.autoDownload = false
        autoUpdater.autoInstallOnAppQuit = true
        autoUpdater.on('update-available', (info: { version: string; releaseName?: string }) => {
          this.set({ available: true, version: info.version, releaseName: info.releaseName ?? undefined })
        })
        autoUpdater.on('update-not-available', () => this.set({ available: false }))
        autoUpdater.on('download-progress', (p: { percent: number }) => this.set({ percent: Math.round(p.percent) }))
        autoUpdater.on('update-downloaded', (info: { version: string }) =>
          this.set({ available: true, version: info.version, downloaded: true })
        )
        autoUpdater.on('error', (err: { message?: string }) => this.set({ error: String(err?.message ?? err) }))
      }
      const result = await autoUpdater.checkForUpdates()
      if (!result) this.set({ available: false })
      return this.current
    } catch (err) {
      this.set({ error: String((err as Error).message ?? err) })
      return this.current
    }
  }

  /** 与 check() 相同的兼容解构：electron-updater 是 CJS，可能挂在 default 下 */
  private async loadAutoUpdater(): Promise<unknown> {
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: unknown
      default?: { autoUpdater?: unknown }
    }
    return mod.autoUpdater ?? mod.default?.autoUpdater ?? null
  }

  async download(): Promise<UpdateInfo> {
    try {
      const autoUpdater = (await this.loadAutoUpdater()) as any
      if (!autoUpdater) {
        this.set({ error: '自动更新组件未加载（electron-updater 未正确打包）' })
        return this.current
      }
      await autoUpdater.downloadUpdate()
      return this.current
    } catch (err) {
      this.set({ error: String((err as Error).message ?? err) })
      return this.current
    }
  }

  quitAndInstall(): void {
    void (async () => {
      const autoUpdater = (await this.loadAutoUpdater()) as any
      if (!autoUpdater) return
      autoUpdater.quitAndInstall(false, true)
    })()
  }
}
