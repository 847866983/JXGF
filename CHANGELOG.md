# Changelog

本项目版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。自动更新依赖 `package.json` 的 `version` 递增。

## 0.9.8

- **导演台**：三段式视频编辑器布局（监视器 / 参数页签 / 时间轴）；剧本与分镜整合为导演台内页签，移除独立入口。
- **参考图绑定**：改为按资产名绑定，提示词写角色名即可；`@图片N` 降为槽位角标。
- **AI 助手**：对话历史随项目持久化（`project.json` 的 `aiChat`），切换项目各自独立，新增「清空记录」。
- **角色资产**：导入剧本 → AI 提取角色 → 资产页生成图 → 提示词写名字绑定参考图，形成闭环。
- **班长全家桶重现**：H3/Rack/Desk 契约、参考图闭环、文案台、10 组节点参数面板、9 大功能域节点目录（详见 `docs/班长全家桶功能分析与重现蓝图.md`）。
- 修复：SLA 关闭写 0、别名三态、种子随机化、删除图片同步删磁盘文件、千问提示词空串覆盖等问题。

## 0.1.0（未发布）

首个可构建、可打包的完整骨架版本。

### 界面（7 个页面）

- **仪表盘**：显卡/显存/档位/ComfyUI 状态总览、项目列表与新建
- **环境检测**：四步自检（显卡档位 / ComfyUI 连接 / 模型库 / 结论）+ 下载任务 + 环境安装（一键下载/解压）
- **资产管理**：角色 / 场景 / 道具 tab、卡片网格、新建/编辑/删除
- **剧本分镜**：剧本 → 剧集 → 场次 → 分镜三级树 + 分镜编辑
- **导演台**：按集时间线、角色引用、单镜/连续生成
- **生成队列**：进度、取消、产物归档
- **设置**：ComfyUI 连接配置、工作流模板导入、在线更新

### 主进程核心

- `ComfyClient`：/system_stats、/upload、/prompt、WS 进度、/history、/view、/object_info
- `hardware`：nvidia-smi + WMI 双路径 GPU 探测
- `presets`：6 档显存预设（6/8/12/16/24GB，受限档），分辨率/帧数/低显存自适应
- `workflow`：模板 → 工作流参数注入（提示词/宽高/帧数/种子）
- `store`：项目 JSON 存储，原子落盘 + 自动 .bak 备份
- `jobs`：任务队列，排队/进度/重试/取消/产物归档
- `download`：断点续传下载引擎（HTTP Range、SHA256 校验、取消）
- `extract`：zip（PowerShell）/ 7z（7-Zip）解压
- `catalog`：组件目录（ComfyUI 便携版 + Wan 2.1 模型，按档位过滤，三源镜像）
- `updater`：electron-updater 封装（检查/下载/重启安装，开发模式自动禁用）

### 工程与发布

- electron-vite + React 19 + TypeScript + Tailwind + zustand
- IPC 契约集中管理，共享类型主/渲染进程同源
- `pnpm test`：42 项核心逻辑自检（档位/注入/客户端降级/下载/解压/目录/存储）
- `scripts/preflight.ps1`：发布前检查（体检 + 验证链 + 可选打包）
- `scripts/gen-icon.ps1` + `scripts/make-ico.mjs`：生成应用图标
- electron-builder NSIS 安装包 + `latest.yml` 自动更新元数据

### 已知限制（首个版本）

- ComfyUI 客户端链路（上传→提交→WS→下载）已在真实 ComfyUI 0.45.3 上端到端验证；**视频生成本身仍需要目标机配置好模型**（当前联调机模型库为空）
- 模型目录当前仅内置 Wan 2.1 T2V 1.3B 一个条目
- 本开发机因无符号链接权限，打包时 `signAndEditExecutable: false`（正式发布需在开发者模式机器上移除并补签名）
- `publish` 更新仓库仍为占位符，发布前需替换为真实 GitHub 仓库
