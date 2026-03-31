const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

/*
  POST /api/probe
  Body: { skus: string[], domain: string, size: number, maxViews: number, fmt: string, concurrency: number }
  Returns: { results: [{ sku, view, url }], total: number, debug: {} }
*/
router.post('/', async (req, res) => {
  const {
    skus        = [],
    domain      = 'apac.humanscale.com',
    size        = 734,
    maxViews    = 20,
    fmt         = 'png',
    concurrency = 20,
  } = req.body;

  if (!skus.length) return res.status(400).json({ error: 'No SKUs provided' });

  const results = [];
  const debug = { tested: 0, found: 0, errors: [] };

  // Build all tasks
  const tasks = [];
  for (const sku of skus) {
    for (let v = 1; v <= maxViews; v++) {
      const url = `https://${domain}/imagesconfig/${sku}_${v}_${size}.${fmt}`;
      tasks.push({ sku, view: v, url });
    }
  }

  console.log(`[PROBE] Starting probe for ${skus.length} SKU(s), max ${maxViews} views each = ${tasks.length} URLs`);

  // Process in batches
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    await Promise.all(batch.map(async ({ sku, view, url }) => {
      try {
        debug.tested++;
        
        // Try HEAD first, then GET if HEAD fails
        let r = await fetch(url, { 
          method: 'HEAD', 
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          }
        }).catch(async () => {
          return fetch(url, {
            method: 'GET',
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            }
          });
        });
        
        if (r && (r.ok || r.status === 200 || r.status === 304)) {
          debug.found++;
          results.push({ sku, view, url });
          console.log(`[PROBE] ✓ ${sku} view ${view} → HTTP ${r.status}`);
        } else {
          const status = r?.status || 'unknown';
          if (debug.errors.length < 5) {
            debug.errors.push({ sku, view, status });
          }
          console.log(`[PROBE] ✗ ${sku} view ${view} → HTTP ${status}`);
        }
      } catch (e) {
        if (debug.errors.length < 5) {
          debug.errors.push({ sku, view, error: e.message });
        }
        console.log(`[PROBE] ✗ ${sku} view ${view} → ${e.message}`);
      }
    }));
  }

  // Remove duplicates
  const seen = new Set();
  const unique = results.filter(r => {
    const key = `${r.sku}_${r.view}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.sku.localeCompare(b.sku) || a.view - b.view);

  console.log(`[PROBE] ✓ Complete: ${unique.length} images found from ${debug.tested} URLs tested`);

  res.json({ 
    total: unique.length, 
    results: unique,
    debug: {
      tested: debug.tested,
      found: debug.found,
      errorCount: debug.errors.length,
      sampleErrors: debug.errors,
      domain,
      skuCount: skus.length,
      maxViews,
      size,
      format: fmt,
    }
  });
});

module.exports = router;
