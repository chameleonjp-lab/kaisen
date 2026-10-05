import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base=process.argv[2];if(!base)throw Error('Usage: node scripts/capture-throttle-comparison.mjs <baseline checkout>');
const output=resolve('test-results/throttle-comparison');await mkdir(output,{recursive:true});
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const facts=[];
try {
 for(const [label,cwd,port]of [['before',resolve(base),4181],['after',process.cwd(),4182]]){
  const server=spawn('npm',['run','dev','--','--host','127.0.0.1','--port',String(port)],{cwd,stdio:'pipe',detached:true});
  try{
   let ready=false;for(let n=0;n<100;n++){try{const response=await fetch(`http://127.0.0.1:${port}`);if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error(`${label} server unavailable`);
   for(const [width,height]of [[393,852],[852,393]]){
    const page=await browser.newPage({viewport:{width,height},hasTouch:true,deviceScaleFactor:1});
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.fulfill({status:200,contentType:'application/json',body:'[]'}));
    await page.clock.install({time:new Date('2026-10-05T00:00:00Z')});
    await page.goto(`http://127.0.0.1:${port}`);await page.locator('#start').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#start').disabled);
    await page.locator('input[value="normal"]').check();
    await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));
    await page.locator('#start').click();await page.clock.runFor(200);
    const state=await page.evaluate(()=>{const state=window.__kaisenReadState(false);return {mode:state.mode,phase:state.phase,tick:state.tick,player:state.player,gunSight:state.gunSight};});
    assert.ok(state.mode==='normal'&&state.phase==='playing'&&state.tick>0,`${label} must be an advancing Normal flight`);
    await page.screenshot({path:`${output}/${label}-${width}x${height}.png`});
    facts.push({label,width,height,mode:'normal',input:'start then neutral, controlled clock +200ms',readout:await page.locator('#speed').innerText(),state,browser:browser.version()});
    await page.close();
   }
  }finally{try{process.kill(-server.pid,'SIGTERM');}catch{server.kill();}}
 }
}finally{await browser.close();}
await writeFile(`${output}/conditions.json`,JSON.stringify(facts,null,2));

for(const before of facts.filter(item=>item.label==='before')) {
 const after=facts.find(item=>item.label==='after'&&item.width===before.width&&item.height===before.height);
 assert.ok(after,'Matching candidate evidence is required');
 assert.deepEqual(after.state,before.state,'Before/after controlled flight state differs');
}
