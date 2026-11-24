// UI 验证：通过 CDP 对运行中的 Electron 渲染层逐页截图。用完可删。
// 用法：node scripts/ui-verify.mjs
import WebSocket from 'ws'
import fs from 'node:fs/promises'
import path from 'node:path'

const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
if (!page) {
  console.error('NO_PAGE_TARGET', JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, title: t.title }))))
  process.exit(1)
}
console.log('TARGET:', page.title, page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(method_name(msg) || JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
function method_name() {
  return 'cdp error'
}
await new Promise((r) => ws.on('open', r))
await send('Page.enable').catch(() => {})

const dir = 'logs/ui-shots'
await fs.mkdir(dir, { recursive: true })

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(dir, `${name}.png`), Buffer.from(data, 'base64'))
  console.log('SAVED', name)
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  return r?.result?.value
}

async function nav(hash, name, scrollJs) {
  const moved = await evalJs(
    `(() => { if (location.hash === ${JSON.stringify(hash)}) return 'already'; location.hash = ${JSON.stringify(hash)}; return 'navigated' })()`
  )
  await sleep(1300)
  if (scrollJs) {
    console.log('scroll:', await evalJs(scrollJs))
    await sleep(600)
  }
  console.log(hash, '->', moved)
  await shot(name)
}

const SCROLL_RUNTIME = `(() => { const el=[...document.querySelectorAll('div,section')].reverse().find(e=>e.textContent && e.textContent.trim().startsWith('本机 ComfyUI') && e.querySelectorAll('button').length<=3); if(el){el.scrollIntoView({block:'center'}); return 'ok'} return 'EL_NOT_FOUND' })()`
const SCROLL_BOTTOM = `(() => { const s=[...document.querySelectorAll('section')].pop(); if(s){s.scrollIntoView({block:'end'}); return 'ok'} window.scrollTo(0,document.body.scrollHeight); return 'body' })()`

await shot('00-current')
await nav('/director?tab=generation', '08-generation')
console.log('GEN_SELECTS:', await evalJs(
  `(() => { const sels=[...document.querySelectorAll('select')].filter(s=>[...s.options].some(o=>/euler|karras/.test(o.value))); return sels.map(s=>({options: s.options.length, first3: [...s.options].slice(1,4).map(o=>o.value)})) })()`
))
await nav('/director', '01-director')
await nav('/queue', '02-queue')
await nav('/settings', '03-settings-top')
await nav('/settings', '04-settings-runtime', SCROLL_RUNTIME)
await nav('/settings', '05-settings-bottom', SCROLL_BOTTOM)
await nav('/assets', '06-assets')
await nav('/dashboard', '07-dashboard')
ws.close()
console.log('DONE')
process.exit(0)
