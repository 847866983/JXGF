// 用多尺寸 PNG 组装成合法的 Windows ICO（ICONDIR + N 条 ICONDIRENTRY + PNG 数据）
// 用法：node scripts/assemble-ico.mjs <png目录> <输出ico> [尺寸...]
import fs from 'node:fs'
import path from 'node:path'

const [dir, outIco, ...sizeArgs] = process.argv.slice(2)
if (!dir || !outIco) {
  console.error('用法: node assemble-ico.mjs <png目录> <输出ico> [尺寸...]')
  process.exit(1)
}
const sizes = sizeArgs.length > 0 ? sizeArgs.map(Number) : [256, 128, 64, 48, 32, 16]

const entries = []
for (const s of sizes) {
  const p = path.join(dir, `icon_${s}.png`)
  const data = fs.readFileSync(p)
  entries.push({ size: s, data })
}

const headerSize = 6
const entrySize = 16
const totalImgSize = entries.reduce((n, e) => n + e.data.length, 0)
const buf = Buffer.alloc(headerSize + entrySize * entries.length + totalImgSize)

buf.writeUInt16LE(0, 0) // reserved
buf.writeUInt16LE(1, 2) // type = icon
buf.writeUInt16LE(entries.length, 4) // count

let offset = headerSize + entrySize * entries.length
let entryPos = headerSize
for (const e of entries) {
  const dim = e.size >= 256 ? 0 : e.size
  buf.writeUInt8(dim, entryPos) // width
  buf.writeUInt8(dim, entryPos + 1) // height
  buf.writeUInt8(0, entryPos + 2) // colorCount
  buf.writeUInt8(0, entryPos + 3) // reserved
  buf.writeUInt16LE(1, entryPos + 4) // planes
  buf.writeUInt16LE(32, entryPos + 6) // bitCount
  buf.writeUInt32LE(e.data.length, entryPos + 8) // bytesInRes
  buf.writeUInt32LE(offset, entryPos + 12) // imageOffset
  e.data.copy(buf, offset)
  offset += e.data.length
  entryPos += entrySize
}

fs.writeFileSync(outIco, buf)
console.log(`ICO 组装完成: ${outIco} (${buf.length} bytes, ${entries.length} 个尺寸: ${sizes.join('/')})`)
