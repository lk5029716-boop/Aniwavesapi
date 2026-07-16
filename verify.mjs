import { chromium } from 'playwright';
function log(...a){ process.stdout.write(a.join(' ')+'\n'); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => log('PAGEERROR:', e.message));
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  await page.click('button.btn:has-text("Play")');
  await page.waitForFunction(() => { const s=document.getElementById('p_server'); return s && s.options.length>1; }, {timeout:15000}).catch(()=>{});
  const opts = await page.$$eval('#p_server option', os=>os.map(o=>o.value)).catch(()=>[]);
  if (opts.some(o=>/vidplay/i.test(o))) { await page.selectOption('#p_server','Vidplay').catch(()=>{}); await page.click('button.btn:has-text("Play")').catch(()=>{}); }
  // poll up to 25s for currentTime to advance
  let last = null;
  for (let i=0;i<13;i++){
    await page.waitForTimeout(2000);
    const s = await page.evaluate(()=>{ const v=document.getElementById('vv'); return {ct:+v.currentTime.toFixed(2),rs:v.readyState,p:v.paused,d:v.duration?+v.duration.toFixed(1):null,ns:v.networkState,buf: v.buffered.length?+v.buffered.end(0).toFixed(2):0, err:(document.getElementById('pErr')||{}).textContent||'', sub:(document.getElementById('pSub')||{}).textContent||''}; });
    log(`t=${i*2+2}s ct=${s.ct} rs=${s.rs} paused=${s.p} dur=${s.d} buf=${s.buf} ns=${s.ns} sub="${s.sub}" err="${s.err}"`);
    if (s.ct > 0.5) { log('PLAYBACK STARTED ✓'); break; }
    last = s;
  }
  await browser.close();
  log('done');
})().catch(e=>{ log('SCRIPT ERROR:', e.message); process.exit(1); });
