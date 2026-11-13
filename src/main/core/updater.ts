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
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-available', (info) => {
        this.set({ available: true, version: info.version, releaseName: info.releaseName ?? undefined })
      })
      autoUpdater.on('update-not-available', () => this.set({ available: false }))
      autoUpdater.on('download-progress', (p) => this.set({ percent: Math.round(p.percent) }))
      autoUpdater.on('update-downloaded', (info) =>
        this.set({ available: true, version: info.version, downloaded: true })
      )
      autoUpdater.on('error', (err) => this.set({ error: err.message }))
      const result = await autoUpdater.checkForUpdates()
      if (!result) this.set({ available: false })
      return this.current
    } catch (err) {
      this.set({ error: String((err as Error).message ?? err) })
      return this.current
    }
  }

  async download(): Promise<UpdateInfo> {
    try {
      const { autoUpdater } = await import('electron-updater')
      await autoUpdater.downloadUpdate()
      return this.current
    } catch (err) {
      this.set({ error: String((err as Error).message ?? err) })
      return this.current
    }
  }

  quitAndInstall(): void {
    void (async () => {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.quitAndInstall(false, true)
    })()
  }
}
