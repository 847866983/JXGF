import { spawn } from 'node:child_process'
const reqs = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'driver', version: '1' } } },
  { id: 2, method: 'tools/call', params: { name: 'create_script', arguments: { projectId: 'prj_ac2719032d9b', name: 'MCP演示剧本' } } },
]
const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','src/mcp/server.ts'], { stdio: ['pipe','pipe','inherit'] })
let buf = ''
const pending = new Map()
child.stdout.on('data', d => {
  buf += d.toString()
  let i
  while((i = buf.indexOf('\n')) >= 0){
    const line = buf.slice(0,i); buf = buf.slice(i+1)
    if(!line.trim()) continue
    try { const msg = JSON.parse(line); if(msg.id && pending.has(msg.id)){ pending.get(msg.id)(msg); pending.delete(msg.id) } } catch {}
  }
})
function send(obj){ return new Promise(res => { pending.set(obj.id, res); child.stdin.write(JSON.stringify(obj)+'\n') }) }

const init = await send(reqs[1-1])
console.log('init ok:', init.result.serverInfo.name)
child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
const r2 = await send(reqs[1])
const script = JSON.parse(r2.result.content[0].text).created
console.log('create_script:', script.name, script.id)

// 建集 -> 场 -> 分镜
const r3 = await send({ id: 3, method: 'tools/call', params: { name: 'create_episode', arguments: { projectId: 'prj_ac2719032d9b', title: '第一集·演示', summary: 'MCP创建', scriptId: script.id } } })
const ep = JSON.parse(r3.result.content[0].text).created
console.log('create_episode:', ep.title, ep.id)

const r4 = await send({ id: 4, method: 'tools/call', params: { name: 'create_scene', arguments: { projectId: 'prj_ac2719032d9b', episodeId: ep.id, title: '雨夜小巷', location: '旧城', time: '夜' } } })
const sc = JSON.parse(r4.result.content[0].text).created
console.log('create_scene:', sc.title, sc.id)

const r5 = await send({ id: 5, method: 'tools/call', params: { name: 'add_shots', arguments: { projectId: 'prj_ac2719032d9b', sceneId: sc.id, shots: [ {title:'镜头A',description:'俯拍雨巷',duration:5}, {title:'镜头B',dialogue:'谁在那儿？',camera:'中景侧跟',duration:6} ] } } })
const shots = JSON.parse(r5.result.content[0].text)
console.log('add_shots:', shots.count, '个 ->', shots.created.map(s=>s.id).join(','))

const r6 = await send({ id: 6, method: 'tools/call', params: { name: 'create_asset', arguments: { projectId: 'prj_ac2719032d9b', kind: 'character', name: '演示角色', description: 'MCP自动建', prompt: 'a demo character, cinematic' } } })
const asset = JSON.parse(r6.result.content[0].text).created
console.log('create_asset:', asset.name, asset.id)

child.kill()
console.log('== 串行全流程 OK ==')
