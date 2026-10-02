import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const { outputFiles } = await build({ stdin: { contents: `export { createOverview } from './src/float/overview.ts'; export { createPanel } from './src/float/index.ts'`,
  resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'OverviewProbe' })
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let id = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  pending.set(++id, resolve); socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  assert.equal(result.result.exceptionDetails, undefined, JSON.stringify(result.result.exceptionDetails))
  return result.result.result.value
}
try {
  await evaluate(outputFiles[0].text)
  await evaluate(`(() => {
    delete window.previewRecall;
    delete window.previewCancelledRecall;
    document.getElementById('dsh-bf-overview-style')?.remove();
    window.previewFixtures = Array.from({length: 3}, (_, i) => {
      const panel = OverviewProbe.createPanel(document, {title: ['Conversation', 'Project files', 'Canvas chart'][i],
        rect: {x: 30 + i * 100, y: 100, width: [480, 260, 760][i], height: [300, 580, 180][i]}, onClose() {}});
      const content = document.createElement('div'); content.style.cssText = 'height:100%;background:' + ['#ffffff','#242424','#eef5ed'][i] + ';color:' + (i===1?'#ffffff':'#202020') + ';padding:20px;box-sizing:border-box';
      const h = document.createElement('h3'); h.textContent = ['Conversation','Project files','Canvas chart'][i]; content.append(h);
      for(let j=0;j<4;j++){const p=document.createElement('p');p.textContent=['Current session message '+(j+1), 'src/components/Panel'+j+'.tsx', 'Report section '+(j+1)][i];content.append(p)}
      if(i===2){const canvas=document.createElement('canvas');canvas.width=240;canvas.height=50;const ctx=canvas.getContext('2d');ctx.fillStyle='#23834b';ctx.fillRect(0,0,240,50);content.append(canvas)}
      panel.body.append(content);return {panel,title:h.textContent};
    });
    window.previewOverview = OverviewProbe.createOverview(document, previewFixtures, (panel, point) => {
      window.previewRecall = point; previewOverview.close(); panel.setRect({...panel.rect(),x:point.x,y:point.y});
    });
  })()`)
  let count = 0
  for (let i = 0; i < 50 && count < 3; i++) {
    count = await evaluate(`document.querySelectorAll('.dsh-bf-overview-preview img').length`)
    if (count < 3) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(count, 3, 'All three window screenshots must render')
  const pixels = await evaluate(`(() => [...document.querySelectorAll('.dsh-bf-overview-preview img')].map(img => {
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;
    return {width:c.width,height:c.height,opaque:p.filter((v,i)=>i%4===3&&v>0).length,colors:new Set(Array.from({length:p.length/4},(_,i)=>p[i*4]+','+p[i*4+1]+','+p[i*4+2])).size};
  }))()`)
  for (const image of pixels) { assert.ok(image.opaque > 1000); assert.ok(image.colors > 10) }
  for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    const overflow = await evaluate(`document.querySelector('.dsh-bf-overview').scrollWidth > innerWidth`)
    assert.equal(overflow, false)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`spikes/overview-${name}.png`, Buffer.from(shot.result.data, 'base64'))
  }
  const firstItem = await evaluate(`(() => {const r=document.querySelector('.dsh-bf-overview-item').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+40}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...firstItem, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...firstItem, button: 'left', clickCount: 1 })
  assert.equal(await evaluate('window.previewRecall ?? null'), null, 'Selecting a window must not recall it yet')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.dsh-bf-overview')).cursor`), 'crosshair')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.dsh-bf-overview-panel')).display`), 'none')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 140, y: 150, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 140, y: 150, button: 'left', clickCount: 1 })
  assert.deepEqual(await evaluate('window.previewRecall'), { x: 140, y: 150 })
  assert.equal(await evaluate(`!!document.querySelector('.dsh-bf-overview')`), false)
  await evaluate(`window.previewOverview = OverviewProbe.createOverview(document, previewFixtures, () => { window.previewCancelledRecall = true });
    document.querySelector('.dsh-bf-overview-item').click();
    document.querySelector('.dsh-bf-overview').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`)
  assert.equal(await evaluate('window.previewCancelledRecall ?? false'), false)
  assert.equal(await evaluate(`!!document.querySelector('.dsh-bf-overview')`), false)
  console.log('Nonblank screenshots; responsive grid; select then crosshair placement; Escape cancels without recalling')
} finally {
  await evaluate(`window.previewOverview?.close();window.previewFixtures?.forEach(e=>e.panel.close())`)
  await send('Emulation.clearDeviceMetricsOverride')
  socket.close()
}
