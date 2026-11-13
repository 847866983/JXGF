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

多数客户端的配置格式类似下面这样（以**DeepSeek Harness / Claude Desktop / Cursor** 为例）：

```json
{
  "mcpServers": {
    "jingxu-studio": {
      "command": "node",
      "args": [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "E:\\剧本\\frameforge\\src\\mcp\\server.ts"
      ],
      "env": {
        "JXGF_PROJECTS": "C:\\Users\\你的用户名\\AppData\\Roaming\\frameforge\\projects"
      }
    }
  }
}
```

**豆包 / 其他客户端**：在其「MCP 服务器」设置里添加一个 **stdio 类型**的服务器即可，`command` 填 `node`，`args` 填上面的数组（或直接填服务器脚本绝对路径）。

## 提供的工具（13 个）

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
