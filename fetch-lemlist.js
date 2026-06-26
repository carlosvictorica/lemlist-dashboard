const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.LEMLIST_API_KEY || '';
const START_DATE = '2025-01-01T00:00:00.000Z';
const OUTPUT_FILE = path.join(__dirname, 'lemlist-data.json');
const CONCURRENCY = 5;
const RATE_DELAY_MS = 150;
// ──────────────────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('❌  Missing API key. Run with: LEMLIST_API_KEY=your_key node fetch-lemlist.js');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(':' + API_KEY).toString('base64');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid API key (401)'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllCampaigns() {
  let all = [], offset = 0;
  while (true) {
    const batch = await get(`https://api.lemlist.com/api/campaigns?limit=100&offset=${offset}`);
    if (!Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    process.stdout.write(`\r  Campaigns fetched: ${all.length}`);
    if (batch.length < 100) break;
    offset += 100;
  }
  console.log();
  return all;
}

async function fetchStats(campaignId) {
  const url = `https://api.lemlist.com/api/v2/campaigns/${campaignId}/stats?startDate=${START_DATE}&endDate=${new Date().toISOString()}`;
  try { return await get(url); }
  catch(e) { return null; }
}

async function fetchAllStats(campaigns) {
  const results = new Array(campaigns.length).fill(null);
  let done = 0;

  async function worker(queue) {
    while (queue.length > 0) {
      const { idx, campaign } = queue.shift();
      await new Promise(r => setTimeout(r, RATE_DELAY_MS));
      results[idx] = await fetchStats(campaign._id);
      done++;
      process.stdout.write(`\r  Stats loaded: ${done}/${campaigns.length}`);
    }
  }

  const queue = campaigns.map((c, i) => ({ idx: i, campaign: c }));
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
  console.log();
  return results;
}

function detectMarket(name) {
  const n = name || '';
  const isField = /field/i.test(n) || /shoptalk/i.test(n);
  const tokens = n.toUpperCase().split(/[\s_\-\[\]\/\.]+/).filter(Boolean);
  const map = {
    'US': 'US', 'USA': 'US',
    'UKI': 'UKI', 'UK': 'UKI', 'IRELAND': 'UKI',
    'DACH': 'DACH', 'DE': 'DACH', 'AT': 'DACH', 'CH': 'DACH', 'GERMANY': 'DACH',
    'FR': 'FR', 'FRANCE': 'FR',
  };
  let market = 'Other';
  for (const t of tokens) {
    if (map[t]) { market = map[t]; break; }
  }
  return { market, isField };
}

async function main() {
  console.log('\n🚀  Lemlist data fetcher');
  console.log('────────────────────────────────');

  console.log('\n📋  Fetching campaigns...');
  const campaigns = await fetchAllCampaigns();
  console.log(`  ✓ ${campaigns.length} campaigns found`);

  console.log('\n📊  Fetching stats (this takes ~30s)...');
  const statsResults = await fetchAllStats(campaigns);
  console.log(`  ✓ Stats loaded`);

  const data = campaigns.map((c, i) => {
    const s = statsResults[i] || {};
    const { market, isField } = detectMarket(c.name);
    return {
      id: c._id,
      name: c.name || 'Unnamed',
      market,
      isField,
      status: c.status || 'unknown',
      nbLeads: s.nbLeads || 0,
      messagesSent: s.messagesSent || 0,
      opened: s.opened || 0,
      clicked: s.clicked || 0,
      replied: s.replied || 0,
      messagesBounced: s.messagesBounced || 0,
      meetingBooked: s.meetingBooked || 0,
      createdAt: c.createdAt || null
    };
  }).filter(c => c.messagesSent > 0);

  const output = {
    generatedAt: new Date().toISOString(),
    totalCampaigns: data.length,
    campaigns: data
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n✅  Done! ${data.length} campaigns with data`);
  console.log(`📁  Saved to: ${OUTPUT_FILE}`);
  console.log('\n👉  Next step: upload lemlist-data.json to your GitHub repo');
  console.log('────────────────────────────────\n');
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
