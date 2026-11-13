/**
 * 把 MCP 服务器编译成单文件 out/mcp/server.mjs（含全部依赖），
 * 供打包版放到 resources/mcp/ 下独立运行。
 * 用法：node scripts/build-mcp.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

// 找 pnpm 虚拟 store 里的 esbuild 二进制
function findEsbuild() {
  const base = path.join(root, 'node_modules', '.pnpm')
  for (const d of fs.readdirSync(base)) {
    if (d.startsWith('@esbuild+win32-x64@')) {
      const exe = path.join(base, d, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
      if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('找不到 esbuild.exe（在 node_modules/.pnpm/@esbuild+win32-x64@* 下）')
}

const esbuild = findEsbuild()
const out = path.join(root, 'out', 'mcp', 'server.mjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
execFileSync(
  esbuild,
  [path.join(root, 'src', 'mcp', 'server.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--packages=bundle'],
  { stdio: 'inherit' }
)
console.log(`MCP server bundled -> ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`)
