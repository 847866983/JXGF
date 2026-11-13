// 把 D 盘原项目（ManjuStudio）的 14 个工作流模板导入到镜序工坊当前项目。
// 用法：node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/import-templates.mjs
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const SRC_DIR = 'D:/ManjuStudio/projects/哥们是女的/templates'
const PROJ_FILE = 'C:/Users/84786/AppData/Roaming/frameforge/projects/prj_ac2719032d9b/project.json'

const uid = (p = 'tpl_') => p + crypto.randomBytes(6).toString('hex')

// 读项目
let raw = await fsp.readFile(PROJ_FILE, 'utf8')
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
const project = JSON.parse(raw)

// 读源目录所有 tpl_*.json
const files = (await fsp.readdir(SRC_DIR)).filter((f) => f.startsWith('tpl_') && f.endsWith('.json') && !f.includes('.bak'))

const imported = []
const skipped = []
const existing = new Set((project.templates || []).map((t) => t.name))

for (const file of files) {
  const srcPath = path.join(SRC_DIR, file)
  let text = await fsp.readFile(srcPath, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const tpl = JSON.parse(text)

  const name = tpl?.meta?.name ?? file.replace(/\.json$/, '')
  const kind = tpl?.meta?.kind === 'video' ? 'video' : 'image'
  const apiJson = tpl?.api ?? tpl

  if (!apiJson || typeof apiJson !== 'object') {
    skipped.push(`${name}（无 api 字段）`)
    continue
  }
  if (existing.has(name)) {
    skipped.push(`${name}（已存在）`)
    continue
  }

  // 提取 mapping（保留原模板的映射信息）
  const mapping = tpl?.meta?.mapping ?? { version: 1 }

  const template = {
    id: uid(),
    name,
    kind,
    description: tpl?.meta?.description ?? '',
    sourceFile: tpl?.meta?.sourceFile ?? file,
    nodeCount: tpl?.meta?.nodeCount,
    apiJson,
    mapping,
    createdAt: new Date().toISOString()
  }
  project.templates = project.templates || []
  project.templates.push(template)
  imported.push({ name, kind })
}

// 落盘（无 BOM）
await fsp.writeFile(PROJ_FILE, JSON.stringify(project, null, 2), 'utf8')

console.log(`导入完成：${imported.length} 个，跳过 ${skipped.length} 个`)
for (const i of imported) console.log(`  ✅ [${i.kind}] ${i.name}`)
for (const s of skipped) console.log(`  ⏭️ ${s}`)
console.log(`\n项目当前模板总数：${project.templates.length}`)
