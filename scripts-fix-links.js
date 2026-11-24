// 只修复被误删的关键顶层符号链接（pnpm hoist 链接），不做全局批量链接以免版本冲突
const fs = require('fs')
const path = require('path')
const root = __dirname
const pnpm = path.join(root, 'node_modules', '.pnpm')
const top = path.join(root, 'node_modules')

// 这些是 electron-vite / vite 启动链路需要、且顶层链接被删的包
const needed = ['esbuild', 'picomatch', 'fdir', 'chokidar', 'rollup', 'postcss', 'vite', 'electron-vite']

// 在 .pnpm 里找包的实际路径
function findPkg(name) {
  const out = []
  for (const entry of fs.readdirSync(pnpm)) {
    const nm = path.join(pnpm, entry, 'node_modules')
    if (!fs.existsSync(nm)) continue
    if (name.includes('/')) {
      const full = path.join(nm, ...name.split('/'))
      if (fs.existsSync(path.join(full, 'package.json'))) out.push(full)
    } else {
      const full = path.join(nm, name)
      if (fs.existsSync(path.join(full, 'package.json'))) out.push(full)
    }
  }
  out.sort((a, b) => a.length - b.length)
  return out[0] || null
}

let created = 0
for (const name of needed) {
  const link = path.join(top, ...name.split('/'))
  if (fs.existsSync(link)) continue
  const target = findPkg(name)
  if (!target) { console.log('未找到包:', name); continue }
  if (name.includes('/')) {
    try { fs.mkdirSync(path.dirname(link), { recursive: true }) } catch {}
  }
  try { fs.symlinkSync(target, link, 'junction'); console.log('已修复:', name, '->', path.relative(root, target)); created++ }
  catch (e) { console.log('修复失败:', name, e.code) }
}
console.log('共修复', created, '个链接')
