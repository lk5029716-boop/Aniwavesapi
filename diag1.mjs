import { chromium } from 'playwright';
function log(...a){ process.stdout.write(a.join(' ')+'\n'); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const msgs = [];
  page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`.slice(0,260)));
  page.on('pageerror', e => msgs.push('PAGEERROR: ' + e.message));
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  await page.click('button.btn:has-text("Play")');  // single click; servers auto-load
  let started = false;
  for (let i=0;i<22;i++){
    await page.waitForTimeout(2000);
    const s = await page.evaluate(()=>{ const v=document.getElementById("vv"); return {ct:+v.currentTime.toFixed(2),rs:v.readyState,buf:v.buffered.length?+v.buffered.end(0).toFixed(2):0,p:v.paused}; });
    log(`t=${(i+1)*2}s ct=${s.ct} rs=${s.rs} buf=${s.buf} paused=${s.p}`);
    if (s.ct > 0.5) { started = true; break; }
  }
  log(started ? 'PLAYBACK STARTED ✓' : 'STILL STUCK ✗');
  log('CONSOLE:\n'+msgs.join('\n'));
  await browser.close(); log('done');
})().catch(e=>{log('ERR:',e.message);process.exit(1);});
