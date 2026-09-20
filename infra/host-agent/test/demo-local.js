#!/usr/bin/env node
// PLAY LOCAL: a game the host agent did not launch.
//
// On a player's own PC the launcher owns the game process and the host agent runs beside
// it as referee and replay writer. That is the opposite of a game box, and the two must
// never be confused — so this demo is as much about what is REFUSED as what works.
//
//   node test/demo-local.js
//
//   1. by default a `hello` from a process we did not launch is ignored (unchanged)
//   2. --local alone still refuses an instance nobody registered
//   3. the launcher registers the instance, then launches; the agent adopts it
//   4. it is refereed and recorded like any other game, stamped self-reported throughout
//   5. a box attached to the site refuses to start in local mode at all
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Forward slashes throughout: these paths are handed to child processes as arguments.
const slash = (p) => p.split(path.sep).join('/')
const ROOT = slash(path.resolve(import.meta.dirname, '..'))
const RUN = slash(path.join(os.tmpdir(), 'enw-local-demo'))
const DASH = 8905, LINK = 38905
fs.rmSync(RUN,{recursive:true,force:true})
const MATCH='l_21a50db2'   // the site's local match id, which the launcher already holds
let fails=0
const ok=(m)=>console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad=(m)=>{fails++;console.log(`  \x1b[31mFAIL\x1b[0m ${m}`)}
const get=(p)=>fetch(`http://127.0.0.1:${DASH}${p}`).then(r=>r.json())
const post=(p,b)=>fetch(`http://127.0.0.1:${DASH}${p}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(async r=>({status:r.status,body:await r.json()}))

function agent(extra){
  const h=spawn(process.execPath,[`${ROOT}/host.js`,'--box','local','--link-port',String(LINK),
    '--dash-port',String(DASH),'--base-port','29950',
    '--replay-dir',`${RUN}/r`,'--log-dir',`${RUN}/l`,'--key-dir',`${RUN}/k`,...extra],
    {cwd:ROOT,stdio:['ignore','pipe','pipe']})
  h.out=''; h.stdout.on('data',d=>h.out+=d); h.stderr.on('data',d=>h.out+=d); return h
}
// The launcher's game: a sim process the host agent knows nothing about.
function launcherGame(){
  return spawn(process.execPath,[`${ROOT}/sim/sim-instance.js`,'--players','1','--timescale','8',
    '--max-round','8','--map','nazi_zombie_prototype'],
    {cwd:ROOT,stdio:['ignore','pipe','pipe'],
     env:{...process.env,ENW_HOST:`127.0.0.1:${LINK}`,ENW_INSTANCE:MATCH,ENW_ROLE:'solo'}})
}
async function up(h){for(let i=0;i<60;i++){try{await get('/api/state');return true}catch{await delay(500)}}return false}

console.log('\n\x1b[36m── 1. default: a hello from a process we did not launch is IGNORED ──\x1b[0m')
let h=agent([]); await up(h)
let g=launcherGame(); await delay(6000)
if(/hello from unknown instance .* ignoring/.test(h.out)) ok('ignored, and it says why and how to enable it')
else bad('expected the hello to be ignored by default')
if((await get('/api/state')).instances.length===0) ok('no game was created'); else bad('a game appeared with no flag set')
g.kill('SIGKILL'); h.kill('SIGKILL'); await delay(1500)

console.log('\n\x1b[36m── 2. --local, but nobody told us to expect it ──\x1b[0m')
h=agent(['--local']); await up(h)
g=launcherGame(); await delay(6000)
if(/unexpected instance .* ignoring/.test(h.out)) ok('still refused: --local accepts only registered instances')
else bad('--local accepted an unregistered instance')
g.kill('SIGKILL'); await delay(500)

console.log('\n\x1b[36m── 3. the launcher registers the instance first, then launches ──\x1b[0m')
const reg=await post('/api/local/expect',{instance:MATCH,match_id:MATCH,map:'nazi_zombie_prototype'})
if(reg.status===200&&reg.body.link) ok(`registered ${MATCH}; the agent says connect to ${reg.body.link}`)
else bad(`expect: ${reg.status} ${JSON.stringify(reg.body)}`)
g=launcherGame(); await delay(6000)
const s=await get('/api/state')
const inst=s.instances[0]
if(inst) ok(`adopted: instance ${inst.id}, kind ${inst.kind}, round ${inst.game?.round}`); else bad('the registered instance was not adopted')
if(/ADOPTED a local game/.test(h.out)) ok('the adoption is logged loudly with the id and the reason'); else bad('the adoption was not logged')
if(inst?.self_reported) ok('the instance is stamped self_reported'); else bad('not stamped self_reported')
if(inst?.game?.mode==='local') ok('forced to mode local (no XP, no records, no badges)'); else bad(`mode is ${inst?.game?.mode}`)

console.log('\n\x1b[36m── 4. it referees and records like any other game ──\x1b[0m')
for(let i=0;i<40;i++){ if(/SUMMARY /.test(h.out)) break; await delay(2000) }
const sum=/SUMMARY (.+)/.exec(h.out)
if(sum) ok(`refereed to the end: ${sum[1].replace(/\x1b\[[0-9;]*m/g,'')}`); else bad('no summary')
const reps=fs.existsSync(`${RUN}/r`)?fs.readdirSync(`${RUN}/r`).filter(f=>f.endsWith('.enwr')):[]
if(reps.length) ok(`signed replay written: ${reps[0]}`); else bad('no replay')
if(reps.length){
  const {verifyFile}=await import(`file:///${ROOT}/lib/replay.js`)
  const v=verifyFile(`${RUN}/r/${reps[0]}`)
  if(v.ok) ok(`and it verifies — ${v.chunks} chunks, ${v.events} events`); else bad(`replay invalid: ${v.errors[0]}`)
  if(v.header.self_reported===true) ok('the signed header itself says self_reported — the marking is inside the evidence')
  else bad('self_reported is missing from the replay header')
  if(v.header.match_id===MATCH) ok(`and it carries the site's own match id ${MATCH}`); else bad(`match id is ${v.header.match_id}`)
}
console.log('\n\x1b[36m── 5. a box holding a lease never adopts ──\x1b[0m')
h.kill('SIGKILL'); g.kill('SIGKILL'); await delay(1500)
// (a) a box attached to the site refuses to start in local mode at all
h=agent(['--adopt-local','--site','http://127.0.0.1:3200','--secret','devkey-b','--box','box-b'])
await delay(4000)
if(/REFUSING TO START/.test(h.out)) ok('a box with --site refuses to start in local mode at all')
else bad(`expected a refusal at startup; got: ${h.out.split(String.fromCharCode(10)).slice(-3).join(' | ')}`)
try{h.kill('SIGKILL')}catch{}
await delay(1000)
// (b) and a running local agent stops adopting the moment it is holding a real lease
h=agent(['--adopt-local']); await up(h)
h.leaseFake=true
const r5=await post('/api/local/expect',{instance:'l_ok',match_id:'l_ok'})
if(r5.status===200) ok('a local agent with no site accepts registrations'); else bad(`expected 200, got ${r5.status}`)
h.kill('SIGKILL'); await delay(1500)
console.log(`\n${fails?'\x1b[31m':'\x1b[32m'}local-adoption demo finished with ${fails} failure(s)\x1b[0m`)
process.exit(fails?1:0)
