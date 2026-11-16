# 镜序工坊 MCP 接入指南

让 AI 助手（豆包 / DeepSeek Harness / Claude / Cursor 等）直接操作镜序工坊的**剧本分镜**与**资产管理**，无需手动点界面。

## 原理

镜序工坊自带一个本地 **MCP 服务器**（stdio 模式），它直接读写项目数据文件（`project.json`），所以：

- **不要求软件 GUI 开着**——AI 照样能读写项目
- 走标准 MCP 协议，任何支持 MCP 的客户端都能接
- 支持批量导入分镜、一键建角色/场景/道具

## 启动方式

```bash
# 在项目根目录
pnpm mcp
# 等价于：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/mcp/server.ts
```

> 需要 Node.js 22+（推荐 24，原生支持直接运行 TypeScript）。

## 项目数据目录

MCP 服务器按以下顺序自动探测项目目录：

1. 环境变量 `JXGF_PROJECTS`（优先，可指向任意项目目录）
2. `%APPDATA%\镜序工坊\projects`
3. `%APPDATA%\frameforge\projects`
4. `%APPDATA%\FrameForge\projects`

> 想让 MCP 操作软件里的项目，请确保上面某个目录存在，或设置 `JXGF_PROJECTS`。

## 在 MCP 客户端里配置

**最简单的方式：打开软件 → 设置 → 最下方「MCP 接入」面板 → 点「复制配置 JSON」**，粘贴到 AI 客户端的 MCP 设置即可。路径由软件自动计算，无需手动改。

配置形如（打包版）：

```json
{
  "mcpServers": {
    "jingxu-studio": {
      "command": "C:\\Program Files\\镜序工坊\\镜序工坊.exe",
      "args": ["C:\\Program Files\\镜序工坊\\resources\\mcp\\server.mjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "JXGF_PROJECTS": "C:\\Users\\你的用户名\\AppData\\Roaming\\frameforge\\projects"
      }
    }
  }
}
```

**关键点：不需要单独安装 Node.js。** `command` 就是软件自身的 exe，`env.ELECTRON_RUN_AS_NODE=1` 让它以纯 Node 模式运行 MCP 服务器。

> 如果你的 MCP 客户端不支持配置 `env`，可改用 `pnpm mcp`（开发环境）或自行用 `cmd` 包装（Windows 中文路径需注意编码）。

**豆包 / 其他客户端**：在其「MCP 服务器」设置里添加一个 **stdio 类型**的服务器，填入上面三个字段（command / args / env）即可。

## 提供的工具（17 个）

| 分类 | 工具 | 说明 |
|---|---|---|
| 项目 | `list_projects` | 列出所有项目（id、名称、资产/分镜数）|
| 项目 | `get_project_summary` | 读取单个项目结构概览 |
| 资产 | `list_assets` | 列资产（可过滤 角色/场景/道具）|
| 资产 | `create_asset` | 新建资产（名称/描述/英文提示词/标签）|
| 资产 | `update_asset` | 修改资产字段 |
| 资产 | `delete_asset` | 删除资产 |
| 剧本 | `create_script` | 新建剧本 |
| 剧本 | `create_episode` | 新建一集 |
| 剧本 | `create_scene` | 新建一场戏 |
| 分镜 | `create_shot` | 新建单个分镜 |
| 分镜 | `add_shots` | **批量**新建分镜（推荐，一次提交整张分镜表）|
| 分镜 | `list_shots` | 列出分镜（可过滤场次）|
| 分镜 | `update_shot` | 修改分镜（标题/描述/台词/运镜/时长/角色/资产）|
| **记忆** | `list_memory` | 列出项目记忆库 5 类文件及是否已填写 |
| **记忆** | `read_memory` | 读取某类记忆（世界观/角色/风格/连续性/决策日志）|
| **记忆** | `write_memory` | 覆盖写入某类记忆 |
| **记忆** | `append_decision` | 向决策日志追加一条带时间戳的决策 |

## 记忆库（本地长期记忆）

每个项目目录下有一个 `memory/` 文件夹，存 5 个纯 markdown 文件，AI 与软件界面都能读写：

| 文件 | 内容 |
|---|---|
| `world.md` | 世界观 / 设定 |
| `characters.md` | 角色小传 |
| `style.md` | 画风 / 文风 / 镜头规范 |
| `continuity.md` | 时间线 / 连续性 |
| `decisions.md` | 决策日志（只追加，带时间戳）|

**为什么能长期保留**：记忆是磁盘上的文件（跟 `project.json` 同目录），不是对话窗口里的临时上下文。关掉软件、换电脑、换 AI，只要项目文件夹在，记忆就在；`write_memory` 覆盖前还会留 `.bak` 备份。

**推荐的 AI 用法**：
```
AI 开工前：read_memory 读 world/characters/style/continuity → 立刻"想起"项目设定
AI 收工时：write_memory 更新设定；append_decision 记录本次决策
```


## 典型 AI 工作流

```
AI: 我先看有哪些项目
  → list_projects

AI: 打开 xxx 项目
  → get_project_summary { projectId }

AI: 建角色和场景（资产）
  → create_asset { kind: "character", name: "陈放", description: "...", prompt: "..." }
  → create_asset { kind: "scene", name: "雨夜小巷", ... }

AI: 建剧本结构
  → create_script { name: "新剧本" }
  → create_episode { title: "第一集", scriptId }
  → create_scene { episodeId, title: "雨夜小巷", ... }

AI: 一次性写完整张分镜表
  → add_shots { sceneId, shots: [ {title, description, dialogue, camera, duration}, ... ] }
```

## 自检

```bash
pnpm test:mcp          # 项目操作层单元测试（7 项）
pnpm test:mcp-client   # 官方 MCP Client 全流程测试（8 项）：建剧本→集→场→批量分镜→资产→落盘
```

## 注意

- **stdio 模式**下，服务器日志走 stderr，stdout 专用于 MCP 协议——不要在服务器代码里 `console.log`。
- 修改会**直接落盘**到 `project.json`（带 `.bak` 备份）。如果软件界面正开着同一个项目，建议操作后重启软件或重新打开项目以刷新界面。
- 所有工具中文描述与字段均与软件界面一致，AI 可以直接理解。
