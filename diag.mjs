import { chromium } from 'playwright';
function log(...a){ process.stdout.write(a.join(' ')+'\n'); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const msgs = [];
  page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`.slice(0,300)));
  page.on('pageerror', e => msgs.push('PAGEERROR: ' + e.message));
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Instrument Hls before clicking: hook window.Hls error events on any instance
  await page.addInitScript(() => {
    const orig = window.Hls;
    window.__hlsErrors = [];
    const check = () => {
      if (window.Hls && !window.__hooked) {
        window.__hooked = true;
        const O = window.Hls;
        // We can't easily wrap instances; instead poll errors via console. Just record version.
        window.__hlsVersion = O.version || 'unknown';
      }
    };
    check();
  });
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  await page.click('button.btn:has-text("Play")');
  await page.waitForFunction(() => { const s=document.getElementById('p_server'); return s && s.options.length>1; }, {timeout:15000}).catch(()=>{});
  const opts = await page.$$eval('#p_server option', os=>os.map(o=>o.value)).catch(()=>[]);
  if (opts.some(o=>/vidplay/i.test(o))) { await page.selectOption('#p_server','Vidplay').catch(()=>{}); await page.click('button.btn:has-text("Play")').catch(()=>{}); }
  await page.waitForTimeout(12000);
  const diag = await page.evaluate(() => {
    const v = document.getElementById('vv');
    const src = v.currentSrc || v.src || '';
    return {
      hlsVersion: window.__hlsVersion || 'n/a',
      HlsType: typeof window.Hls,
      isSupported: !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported()),
      videoSrc: src.slice(0,120),
      videoError: v.error ? {code:v.error.code, message:v.error.message} : null,
      readyState: v.readyState, ct:+v.currentTime.toFixed(2), dur: v.duration?+v.duration.toFixed(1):null,
      networkState: v.networkState,
      sub: (document.getElementById('pSub')||{}).textContent || '',
      err: (document.getElementById('pErr')||{}).textContent || '',
    };
  });
  log('DIAG: ' + JSON.stringify(diag, null, 2));
  log('CONSOLE (' + msgs.length + '):');
  log(msgs.join('\n') || '(none)');
  await browser.close();
  log('done');
})().catch(e=>{ log('SCRIPT ERROR:', e.message); process.exit(1); });
