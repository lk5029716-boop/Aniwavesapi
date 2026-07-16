import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-gpu']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => logs.push('REQFAIL: ' + r.url().slice(0,90) + ' ' + (r.failure()?.errorText||'')));

  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  await page.click('button.btn:has-text("Play")');
  await page.waitForFunction(() => {
    const s = document.getElementById('p_server');
    return s && s.options.length > 1;
  }, { timeout: 15000 }).catch(()=>{});
  const opts = await page.$$eval('#p_server option', os => os.map(o => o.value)).catch(()=>[]);
  if (opts.some(o => /vidplay/i.test(o))) {
    await page.selectOption('#p_server', 'Vidplay').catch(()=>{});
    await page.click('button.btn:has-text("Play")').catch(()=>{});
  }

  await page.waitForTimeout(12000);

  const hlsInfo = await page.evaluate(() => {
    const v = document.getElementById('vv');
    let hlsState = 'n/a';
    try {
      // hls.js exposes nothing globally; inspect video.buffered
      hlsState = 'buffered=' + (v.buffered.length ? v.buffered.end(0).toFixed(2) : 'none');
    } catch(e){ hlsState = 'err:'+e.message; }
    return {
      hlsLoaded: typeof window.Hls,
      hlsSupported: (window.Hls && window.Hls.isSupported()) || false,
      readyState: v.readyState,
      paused: v.paused,
      currentTime: +v.currentTime.toFixed(2),
      networkState: v.networkState,
      buffered: hlsState,
      err: document.getElementById('pErr') ? document.getElementById('pErr').textContent : '',
    };
  });

  console.log('=== HLS/VIDEO INFO ===');
  console.log(JSON.stringify(hlsInfo, null, 2));
  console.log('=== BROWSER CONSOLE (all) ===');
  console.log(logs.join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
