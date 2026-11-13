// 用 BanZhang 新版工作流替换旧版 H3 模板：
// 1. 删除所有旧版 H3 视频模板（H3_ 前缀节点，依赖已删除的旧包）
// 2. 保留图片模板
// 3. 导入 BanZhang 版 H3 三采（已转成 API）
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const PROJ_FILE = 'C:/Users/84786/AppData/Roaming/frameforge/projects/prj_ac2719032d9b/project.json'
const BANZHANG_API = 'D:/镜序工坊/_banzhang-api.json'

const uid = () => 'tpl_' + crypto.randomBytes(6).toString('hex')

let raw = await fsp.readFile(PROJ_FILE, 'utf8')
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
const project = JSON.parse(raw)

// 读 BanZhang API
let apiRaw = await fsp.readFile(BANZHANG_API, 'utf8')
if (apiRaw.charCodeAt(0) === 0xfeff) apiRaw = apiRaw.slice(1)
const api = JSON.parse(apiRaw)

// 1. 删除旧版 H3 视频模板（名称含 "MiniMax H3" 或 "video_minimax_h3"）
const before = project.templates.length
const removed = []
project.templates = project.templates.filter((t) => {
  const isOldH3 = t.kind === 'video' && (/MiniMax H3/.test(t.name) || /video_minimax_h3/.test(t.name))
  if (isOldH3) removed.push(t.name)
  return !isOldH3
})

// 2. 导入 BanZhang 模板
const banZhangTemplate = {
  id: uid(),
  name: 'MiniMax H3 三采（BanZhang 版）',
  kind: 'video',
  description: 'BanZhang-All-1101 节点，三采视频生成',
  sourceFile: 'minimax h3-三采-1031.json',
  nodeCount: Object.keys(api).length,
  apiJson: api,
  mapping: { version: 1 },
  createdAt: new Date().toISOString()
}
project.templates.push(banZhangTemplate)

await fsp.writeFile(PROJ_FILE, JSON.stringify(project, null, 2), 'utf8')

console.log(`删除旧版 H3 模板 ${removed.length} 个：`)
for (const r of removed) console.log(`  ❌ ${r}`)
console.log(`\n新增 BanZhang 模板 1 个：`)
console.log(`  ✅ MiniMax H3 三采（BanZhang 版）`)
console.log(`\n模板总数：${before} -> ${project.templates.length}`)
console.log('\n最终模板清单：')
for (const t of project.templates) console.log(`  [${t.kind}] ${t.name}`)
