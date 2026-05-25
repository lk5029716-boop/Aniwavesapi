/**
 * Test MyCloud (Echovideo embed-0) extraction directly
 * MyCloud URLs go to play.echovideo.ru/embed-0/...
 * The Echovideo extractor calls /embed-0/getSources?id={sourceId}
 */
import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://aniwaves.ru/';

async function test() {
  // Test with a real MyCloud URL from aniwaves.ru
  const embedUrl = 'https://play.echovideo.ru/embed-0/L7VmgDHYxQ9JOrfUd4MmKuwKYUHORPdHUNnCC8XgDqTVh3qj6ZvnyJR0C7gUvq9D1NCnFSgfd3FRD4D2ea_5h457KFArCEibCaPEUTLkQFAco9ososuGOvKGTw_vbY6R1sMSoZSa8KxZx84_69UFRiqBjOeZFxFDzT_HrNTteCw?v=1&asi=0&autoPlay=0&ao=0';

  console.log('Embed URL:', embedUrl);

  // Step 1: Extract embedPrefix and sourceId like the real extractor does
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;
  const pathMatch = urlObj.pathname.match(/^\/(embed-\d+)\//);
  const embedPrefix = pathMatch?.[1] ?? 'embed-1';
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const sourceId = pathParts[pathParts.length - 1];
  
  console.log(`Host: ${host}`);
  console.log(`Embed prefix: ${embedPrefix}`);
  console.log(`Source ID: ${sourceId.substring(0, 40)}...`);

  // Step 2: Call getSources API
  const sourcesUrl = `https://${host}/${embedPrefix}/getSources`;
  console.log(`\nCalling: GET ${sourcesUrl}?id=${sourceId.substring(0, 40)}...`);

  try {
    const resp = await axios.get(sourcesUrl, {
      params: { id: sourceId },
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, */*',
        'Referer': embedUrl,
        'Origin': `https://${host}`,
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Site': 'same-origin',
      },
      timeout: 15000,
    });
    
    console.log(`Status: ${resp.status}`);
    console.log(`Data:`, JSON.stringify(resp.data, null, 2).substring(0, 1000));
    
    const data = resp.data;
    if (typeof data.sources === 'string') {
      console.log(`\n✓ m3u8 found: ${data.sources}`);
    } else if (Array.isArray(data.sources)) {
      console.log(`\nSources array:`, data.sources.slice(0, 3));
    } else if (data.sources) {
      console.log(`\nSources type:`, typeof data.sources, JSON.stringify(data.sources).substring(0, 200));
    } else {
      console.log(`\n✗ No sources in response`);
    }
  } catch (err) {
    console.error(`\n✗ Request failed:`, err.message);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`);
      console.error(`  Body:`, JSON.stringify(err.response.data).substring(0, 500));
    }
  }
}

test().catch(console.error);