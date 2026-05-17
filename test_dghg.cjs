const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36' });
  const page = await ctx.newPage();

  let videoUrl = null;
  page.on('request', req => {
    const url = req.url();
    if (url.includes('cloudatacdn')) {
      console.log('CDN REQUEST:', url.slice(0, 200));
      videoUrl = url;
    }
  });

  console.log('Navigating...');
  await page.goto('https://playmogo.com/e/cn3fn0zskodx', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto:', e.message));

  console.log('URL:', page.url());
  console.log('Waiting 20s...');

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if (videoUrl) break;
    process.stdout.write(i + ' ');
  }
  console.log('');

  if (videoUrl) {
    console.log('FOUND:', videoUrl);
  } else {
    console.log('Not found in network. Checking HTML...');
    const content = await page.content();
    const re = new RegExp('https?://[^"\\s]+token=[^"\\s]+', 'g');
    const matches = content.match(re);
    if (matches) {
      console.log('HTML matches:', matches.slice(0, 5));
    } else {
      console.log('Nothing in HTML. Title:', await page.title());
      console.log('Content length:', content.length);
      // look for video tag
      const vidMatch = content.match(/<video[^>]*src="([^"]+)"/);
      if (vidMatch) console.log('Video src:', vidMatch[1]);
      // look for source tag
      const srcMatch = content.match(/<source[^>]*src="([^"]+)"/);
      if (srcMatch) console.log('Source src:', srcMatch[1]);
      // look for js video data
      const jsMatch = content.match(/file["\s:]+["](https?:\/\/[^"]+)["]/);
      if (jsMatch) console.log('JS file:', jsMatch[1]);
    }
  }

  await browser.close();
})().catch(e => console.error('FATAL:', e.message));
