// 把 build/icon.png 组装成 Windows 可用的单条目 ICO（256x256 PNG 压缩条目）。
// 先运行 scripts/gen-icon.ps1 生成 PNG，再运行本脚本：node scripts/make-ico.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pngPath = path.join(root, 'build', 'icon.png')
const icoPath = path.join(root, 'build', 'icon.ico')

const png = fs.readFileSync(pngPath)
const buf = Buffer.alloc(22 + png.length)
buf.writeUInt16LE(0, 0) // reserved
buf.writeUInt16LE(1, 2) // type: icon
buf.writeUInt16LE(1, 4) // count
buf[6] = 0 // width 0 => 256
buf[7] = 0 // height 0 => 256
buf[8] = 0 // palette
buf[9] = 0 // reserved
buf.writeUInt16LE(1, 10) // planes
buf.writeUInt16LE(32, 12) // bpp
buf.writeUInt32LE(png.length, 14) // bytes in resource
buf.writeUInt32LE(22, 18) // image offset
png.copy(buf, 22)
fs.writeFileSync(icoPath, buf)
console.log(`icon.ico -> ${icoPath} (${buf.length} bytes)`)
