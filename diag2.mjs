import { chromium } from 'playwright';
function log(...a){ process.stdout.write(a.join(' ')+'\n'); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url().slice(0,140) + ' :: ' + (r.failure()?.errorText||'')));
  page.on('response', r => { if (r.url().includes('/api/proxy') && r.status()>=400) failed.push('HTTP'+r.status()+' '+r.url().slice(0,140)); });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.fill('#p_id', 'naruto-76396');
  await page.fill('#p_ep', '1');
  await page.selectOption('#p_type', 'sub');
  await page.click('button.btn:has-text("Play")');
  await page.waitForTimeout(15000);
  log('FAILED/4xx REQUESTS:');
  log(failed.join('\n') || '(none)');
  await browser.close(); log('done');
})().catch(e=>{log('ERR:',e.message);process.exit(1);});
