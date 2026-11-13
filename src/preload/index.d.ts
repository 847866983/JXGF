import type { FrameForgeApi } from './index'

declare global {
  interface Window {
    api: FrameForgeApi
  }
}

export {}
