import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { UpdateInfo } from '@shared/types'

type Emit = (payload: { type: 'update:state'; info: UpdateInfo }) => void

/** 内置发布源（与 electron-builder.yml 的 publish 段保持一致） */
const GITHUB_OWNER = '847866983'
const GITHUB_REPO = 'JXGF'

/**
 * 在线自动更新：基于 electron-updater。
 * 发布到 GitHub Releases（见 electron-builder.yml 的 publish 段）。
 * 开发模式（未打包）下自动禁用，避免干扰调试。
 */
export class Updater {
  private current: UpdateInfo = { available: false }
  private emit: Emit | null = null
  private listenersBound = false

  constructor() {
    this.current = {
      available: false,
      currentVersion: app.getVersion(),
      version: app.getVersion(),
      releaseNotes: app.isPackaged ? '' : '开发模式：自动更新未启用（打包后生效）'
    }
  }

  /**
   * 确保 app-update.yml 存在。
   *
   * electron-builder 正式打包会把 publish 配置写成 resources/app-update.yml；
   * 但某些构建方式（如 --dir、或自定义 extraResources）可能漏掉它，
   * 这时 electron-updater 会直接抛 ENOENT。这里在缺失时补一份内置配置，
   * 让在线更新在打包环境下始终可用。
   */
  private ensureUpdateConfig(): void {
    try {
      const dir = path.join(process.resourcesPath, 'app-update.yml')
      if (fs.existsSync(dir)) return
      const yml = [
        'provider: github',
        `owner: ${GITHUB_OWNER}`,
        `repo: ${GITHUB_REPO}`,
        'releaseType: release',
        ''
      ].join('\n')
      fs.writeFileSync(dir, yml, 'utf8')
    } catch {
      // 只读目录等情况下写入失败，交给 electron-updater 自己报错
    }
  }

  setEmitter(emit: Emit): void {
    this.emit = emit
  }

  getInfo(): UpdateInfo {
    return this.current
  }

  private set(info: Partial<UpdateInfo>): void {
    // currentVersion 永远是本机真实版本，绝不被远端版本号覆盖
    this.current = { ...this.current, currentVersion: app.getVersion(), ...info }
    this.emit?.({ type: 'update:state', info: this.current })
  }

  async check(): Promise<UpdateInfo> {
    if (!app.isPackaged) {
      this.set({ available: false, releaseNotes: '开发模式：自动更新未启用（打包后生效）' })
      return this.current
    }
    this.ensureUpdateConfig()
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
          this.set({ available: true, version: info.version, releaseName: info.releaseName ?? undefined, downloaded: false })
        })
        autoUpdater.on('update-not-available', () => this.set({ available: false, version: app.getVersion() }))
        autoUpdater.on('download-progress', (p: { percent: number }) => this.set({ percent: Math.round(p.percent) }))
        autoUpdater.on('update-downloaded', (info: { version: string }) =>
          this.set({ available: true, version: info.version, downloaded: true, percent: 100 })
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

  /** 与 check() 相同的兼容解析：electron-updater 是 CJS，可能挂在 default 上 */
  private async loadAutoUpdater(): Promise<unknown> {
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: unknown
      default?: { autoUpdater?: unknown }
    }
    return mod.autoUpdater ?? mod.default?.autoUpdater ?? null
  }

  async download(): Promise<UpdateInfo> {
    this.ensureUpdateConfig()
    try {
      const autoUpdater = (await this.loadAutoUpdater()) as any
      if (!autoUpdater) {
        this.set({ error: '自动更新组件未加载（electron-updater 未正确打包）' })
        return this.current
      }
      this.set({ percent: 0, error: undefined })
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
