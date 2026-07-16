import { chromium } from 'playwright';

function log(...a){ process.stdout.write(a.join(' ')+'\n'); }

(async () => {
  log('launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required']
  });
  log('browser launched');
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => logs.push('REQFAIL: ' + r.url().slice(0,80) + ' ' + (r.failure()?.errorText||'')));

  log('goto...');
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  log('filled form');
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  log('click play');
  await page.click('button.btn:has-text("Play")');
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const v = document.getElementById('vv');
    return {
      hlsType: typeof window.Hls,
      hlsSupported: !!(window.Hls && window.Hls.isSupported()),
      readyState: v.readyState,
      paused: v.paused,
      currentTime: +v.currentTime.toFixed(2),
      duration: +v.duration.toFixed(2),
      networkState: v.networkState,
      err: (document.getElementById('pErr')||{}).textContent || '',
      sub: (document.getElementById('pSub')||{}).textContent || '',
    };
  });
  log('INFO: ' + JSON.stringify(info));
  log('CONSOLE:\n' + (logs.join('\n') || '(none)'));
  await browser.close();
  log('done');
})().catch(e => { log('SCRIPT ERROR: ' + e.message); process.exit(1); });
