# 镜序工坊

本地 AI 视频生成工作台 —— 资产库 / 剧本分镜 / 导演台，后端对接 ComfyUI。

面向两类读者：

- **开发者**：想在本机跑起来、改代码、打包发布；
- **二开用户**：想基于这份代码做自己的生成工具。

---

## 目录

- [功能清单](#功能清单)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [开发](#开发)
  - [安装依赖](#安装依赖)
  - [常用命令](#常用命令)
- [打包](#打包)
- [数据存放](#数据存放)
- [显存档位表](#显存档位表)
- [在线更新](#在线更新)
- [常见问题](#常见问题)

---

## 功能清单

| 模块 | 说明 |
|---|---|
| 本地 ComfyUI 视频生成 | 通过 ComfyUI 的 HTTP API + WebSocket 提交工作流、实时接收进度、自动下载产物并归档 |
| 资产管理 | 角色 / 场景 / 道具三类资产，含提示词、标签、参考图与版本记录，全项目共享；支持「导入剧本 → AI 提取角色资产 → 生成角色图 → 提示词写资产名绑定参考图」 |
| 记忆库 | 世界观 / 角色 / 风格 / 连续性 / 决策日志，供 AI 助手读写 |
| AI 助手 | 内置 H3AI 导演助理，读项目记忆、按 H3 规则写分镜、可做机检；对话历史随项目保存 |
| 导演台 | 三段式视频编辑器布局（监视器 / 参数面板 / 时间轴）；含分段时间线、片子级与本段提示词、按资产名绑定参考图、节点级参数、生成信息与工作流切换；剧本与分镜已整合为其内页签 |
| 生成队列 | 单任务排队、进度推送、失败自动重试、取消任务，产物回写分镜 |
| 硬件探测与显存档位 | 启动时探测 GPU（`nvidia-smi` / WMI），按显存自动给出分辨率/帧数预设 |
| 在线更新 | 基于 electron-updater，打包版本启动后静默检查、下载、退出安装 |

界面包含七个页面：仪表盘（Dashboard）、资产管理（Assets）、记忆库（Memory）、AI 助手（AI）、导演台（Director）、生成队列（Queue）、设置（Settings）。原独立「剧本分镜」页已整合进导演台的「剧本与分镜」页签，旧地址 `/storyboard` 自动跳转。

---

## 技术栈

- **运行时**：Electron 33（自带 Chromium 与 Node，目标机无需预装）
- **构建**：electron-vite 3 + Vite 6
- **界面**：React 19 + TypeScript 5.7 + Tailwind CSS 3.4 + lucide-react（图标）+ zustand（状态）+ react-router-dom（路由）
- **主进程**：Node（`node:child_process`、`node:fs/promises`）、`ws`（ComfyUI WebSocket）
- **打包**：electron-builder 25，目标 NSIS 安装包（Windows x64）
- **更新**：electron-updater 6

ComfyUI 作为**独立后端进程**存在，本应用不内嵌 Python/CUDA/torch；主进程通过 `src/main/core/comfy.ts` 与它通信（HTTP `/prompt`、`/history`、`/view` 与 WebSocket `/ws`）。

---

## 目录结构

```text
frameforge/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 入口：窗口、IPC 注册、启动流程、更新检查
│   │   └── core/
│   │       ├── hardware.ts      # GPU 探测（nvidia-smi 优先，WMI 兜底）
│   │       ├── presets.ts       # 显存档位表 PRESETS 与档位判定
│   │       ├── comfy.ts         # ComfyUI HTTP/WS 客户端
│   │       ├── workflow.ts      # 工作流构建：模板 + 参数注入
│   │       ├── node-inject.ts   # 节点级参数探测式注入（按 class_type）
│   │       ├── h3-contract.ts   # H3/Rack/Desk 三大数据契约构造
│   │       ├── h3-prompt.ts     # 别名展开 / @图片N 槽位 / 名字绑定规则
│   │       ├── ai-assistant.ts  # H3AI 助理：工具调用 + 剧本文本提取角色
│   │       ├── jobs.ts          # 生成队列（排队/进度/重试/归档/回写分镜）
│   │       ├── store.ts         # 项目存储（project.json + media/）
│   │       └── updater.ts       # electron-updater 封装（开发态自动禁用）
│   ├── preload/
│   │   └── index.ts             # contextBridge 安全桥（window.api）
│   ├── shared/                  # 主/渲染进程共享代码
│   │   ├── types.ts             # 领域模型（Project/Shot/Asset/Job…）
│   │   ├── ipc.ts               # IPC 通道常量 CH
│   │   ├── node-params.ts       # 节点参数默认值与类型
│   │   └── node-catalog.ts      # 9 大功能域节点能力目录
│   └── renderer/                # React 界面
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── components/      # Sidebar、DirectorStage、DeskPanel、RefBindingPanel 等
│           ├── pages/           # Dashboard / Assets / Memory / AI / Director / Queue / Settings
│           └── store/           # zustand 应用状态
├── electron.vite.config.ts
├── electron-builder.yml         # 打包与 publish（GitHub: 847866983/JXGF）
├── dev-app-update.yml           # 开发态更新配置（electron-updater）
├── pnpm-workspace.yaml          # pnpm 10+ 构建脚本放行（electron / esbuild）
├── package.json
└── docs/                        # 发布与在线更新说明
```

架构上「逻辑清楚」的关键约定：

1. **单一领域模型**：`src/shared/types.ts` 定义 `Project → Script → Episode → Scene → Shot`，主进程与渲染进程共用一份类型，不存在两套字段。
2. **IPC 通道集中管理**：`src/shared/ipc.ts` 的 `CH` 常量被 main / preload / renderer 三方共同引用，避免魔法字符串。
3. **ComfyUI 只当黑盒**：业务层只面对 `ComfyClient`（`connect/submit/history/download/interrupt`），不直接拼工作流 JSON。
4. **单一真相在任务队列**：`UI 发命令 → JobManager → ComfyClient → ComfyUI → WS 进度 → 归档 → 回写分镜`。

---

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（64 位） |
| Node.js | 22 及以上 |
| 包管理器 | pnpm 10 及以上 |
| ComfyUI | 已启动并监听 `127.0.0.1:8188`（地址可在应用「设置」页修改） |
| GPU（生成视频） | NVIDIA 显卡；6GB 显存为最低可跑档，8GB 以上体验更佳 |

> 无 NVIDIA 显卡时应用仍可运行，但硬件探测会把模式降级为「仅出图 / 远程 ComfyUI」，视频生成按钮会被限制（见 [显存档位表](#显存档位表)）。

---

## 开发

### 安装依赖

```bash
pnpm install
```

说明：

- 项目根目录的 `pnpm-workspace.yaml` 已经放行了 `electron` 与 `esbuild` 的安装后构建脚本（`allowBuilds`），因此 **pnpm 10 / 11 可直接安装**。
- 如果你使用的是 pnpm 11 且仍弹出「Ignored build scripts」提示，可手动执行 `pnpm approve-builds --all` 批准全部构建脚本（本项目只需要批准 electron 与 esbuild）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动开发模式（electron-vite dev，热更新渲染进程） |
| `pnpm build` | 构建主进程 / preload / 渲染进程到 `out/` |
| `pnpm typecheck` | 类型检查（`tsconfig.node.json` + `tsconfig.web.json`） |
| `pnpm test` | 核心逻辑自检（档位判定 / 工作流注入 / ComfyUI 客户端离线降级，17 项断言，无需 GUI） |
| `pnpm test:integration` | 真实 ComfyUI 端到端联调（需 8188 在线）：上传→提交→WS→下载 全链路 |
| `pnpm mcp` | 启动 MCP 服务器（stdio），供豆包/DeepSeek Harness 等 AI 客户端接入剧本分镜与资产管理 |
| `pnpm start` | 以 preview 模式运行已构建产物 |
| `pnpm package` | 构建 + 打包 NSIS 安装包（见 [打包](#打包)） |
| `pnpm package:dir` | 构建 + 输出未打包目录（`release/win-unpacked`，调试用） |

---

## 打包

```bash
pnpm package
```

等价于 `electron-vite build && electron-builder --win`，产物输出到 **`release/`**：

- `镜序工坊-Setup-<版本>.exe`（NSIS 安装包）
- 配置了 `publish` 后还会生成 `latest.yml`（供自动更新读取）

打包配置在 [electron-builder.yml](electron-builder.yml)：安装器为 `oneClick: false`、可选安装目录、创建桌面与开始菜单快捷方式。

### 应用图标

已提供图标生成脚本，产物落在 `build/`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-icon.ps1   # 生成 build/icon.png（256px 播放三角）
node scripts\make-ico.mjs                                                  # 由 icon.png 组装 build/icon.ico
```

`electron-builder.yml` 已引用 `build/icon.ico`。正式发布如需多尺寸 ICO，可自行替换；256px PNG 条目在 Windows Vista+ 有效。

> `electron-builder.yml` 已开启 `signAndEditExecutable: true`（嵌入图标与版本信息）。本机无符号链接权限，打包依赖预置的 winCodeSign 缓存；若在新机器上打包失败，见 [docs/发布与校验流程.md](docs/发布与校验流程.md) 第 4 节的手动解压绕过方法。

### 发布前检查

```powershell
# 类型检查 + 自检 + 构建（不带打包）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1

# 完整链路（含 electron-builder 打包 + 产物校验）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Package
```

脚本会体检图标、`signAndEditExecutable`、`publish` 配置，再跑 typecheck / selftest / build / package，任一失败返回非零退出码。 publishes 到 GitHub Release 另需 `GH_TOKEN`，详见 [docs/发布与校验流程.md](docs/发布与校验流程.md)。

---

## 数据存放

所有项目数据存放在 `app.getPath('userData')` 下的 `projects\` 目录：

```text
<userData>\projects\
└── <项目ID>\
    ├── project.json      # 项目全部数据（资产/剧本/分镜/模板/设置）
    ├── project.json.bak  # 每次落盘前自动备份的上一版本
    └── media\            # 生成产物与参考图
```

- **无数据库**：文件即真相，直接复制整个 `projects\` 目录即可备份/迁移。
- 落盘采用「写临时文件 → 备份旧文件 → 原子 rename」，异常断电最多丢最近一次改动，不会损坏已有数据。
- 用户数据目录的实际路径：
  - 开发态：`%APPDATA%\frameforge\projects`
  - 打包态：`%APPDATA%\镜序工坊\projects`
  - 具体以 `src/main/index.ts` 中 `app.getPath('userData')` 的返回值为准。

---

## 显存档位表

显存档位定义在 [src/main/core/presets.ts](src/main/core/presets.ts) 的 `PRESETS`，启动时由 `presetFor(vramMB)` 按实测显存自动匹配：

| 档位 | 显存范围 | 视频分辨率 | 帧数 | 采样轮次 | lowvram | 量化模型 | 说明 |
|---|---|---|---|---|---|---|---|
| 旗舰档 | ≥ 24GB | 1920×1080 | 97 | 3 | 否 | 否 | 全分辨率全帧数 |
| 进阶档 | 16–24GB | 1280×720 | 81 | 2 | 否 | 否 | 720p 高帧数 |
| 标准档 | 12–16GB | 1280×720 | 65 | 2 | 否 | **是** | 720p 标准帧数 |
| 入门档 | 8–12GB | 1024×576 | 49 | 1 | 否 | **是** | 576p |
| 低配档 | 6–8GB | 896×480 | 33 | 1 | **是** | **是** | 480p 短帧 |
| 受限档 | < 6GB | 640×360 | 16 | 1 | **是** | **是** | 仅建议出图或走远程模式 |

判定逻辑（`buildHardwareReport`）：

- NVIDIA 且显存 ≥ 6GB → `local-full`（本地视频生成）；
- NVIDIA 但显存 < 6GB → `local-image`（本地仅建议出图）；
- AMD / Intel → `local-image`（Windows 上视频工作流支持有限，建议出图或远程）；
- 无可用显卡 → `remote`（需配置远程 ComfyUI 地址）。

---

## 在线更新

- 实现封装在 [src/main/core/updater.ts](src/main/core/updater.ts)：`check()` / `download()` / `quitAndInstall()`。
- **开发模式（未打包）自动禁用**：`app.isPackaged === false` 时 `check()` 直接返回「开发模式未启用」，避免调试时误连发布渠道。
- 发布渠道由 [electron-builder.yml](electron-builder.yml) 的 `publish` 段决定（当前为真实公开仓库 `847866983/JXGF`）。
- 完整的发布与更新流程见 [docs/发布与在线更新.md](docs/发布与在线更新.md)。

---

## 常见问题

### 1. 连接 ComfyUI 失败（8188 连不上）

- 确认 ComfyUI 已启动，并监听 `127.0.0.1:8188`（浏览器访问 `http://127.0.0.1:8188` 应能看到 ComfyUI 界面）；
- 在应用「设置」页确认 host / port 与协议正确；
- 若 ComfyUI 在另一台机器，把 host 改成对方 IP，并确认防火墙放行 8188。

### 2. 生成时显存不足（CUDA out of memory）

- 硬件探测会自动给出档位，但仍可在「设置」页手动降低分辨率 / 帧数；
- 低配档已默认开启 `lowvram` 与量化模型；6GB 显存建议优先使用 480p 短帧预设；
- 关闭其他占用显存的程序（浏览器、游戏、其他 AI 工具）。

### 3. 提示模型缺失（model not found / value not in list）

- 打开 ComfyUI 的模型目录，确认工作流所引用的 checkpoint / LoRA / VAE / diffusion model 已放入对应子目录；
- 若模型放在自定义位置，在 ComfyUI 的 `extra_model_paths.yaml` 中指向它，并重启 ComfyUI；
- 重新选择模板后，在「生成队列」里再试一次。

### 4. 打包后没有自定义图标

- 见 [打包 → 应用图标](#应用图标)：新建 `build/icon.ico` 后重新 `pnpm package`。

### 5. 项目数据在哪里、怎么备份

- 见 [数据存放](#数据存放)：直接复制 `projects\` 目录即可。
