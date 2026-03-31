const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

/*
  POST /api/probe
  Body: { skus: string[], domain: string, size: number, maxViews: number, fmt: string }
  Returns: { results: [{ sku, view, url }] }
*/
router.post('/', async (req, res) => {
  const {
    skus     = [],
    domain   = 'apac.humanscale.com',
    size     = 734,
    maxViews = 20,
    fmt      = 'png',
  } = req.body;

  if (!skus.length) return res.status(400).json({ error: 'No SKUs provided' });

  const base    = `https://${domain}/imagesconfig/`;
  const results = [];
  const errors  = [];

  // Probe all SKU × view combinations concurrently (batched)
  const tasks = [];
  for (const sku of skus) {
    for (let v = 1; v <= maxViews; v++) {
      tasks.push({ sku, view: v, url: `${base}${sku}_${v}_${size}.${fmt}` });
    }
  }

  const CONCURRENCY = 20;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ sku, view, url }) => {
      try {
        const r = await fetch(url, { method: 'HEAD', timeout: 6000 });
        if (r.ok) results.push({ sku, view, url });
      } catch (e) {
        // image not found — skip
      }
    }));
  }

  // Sort: sku asc, view asc
  results.sort((a, b) => a.sku.localeCompare(b.sku) || a.view - b.view);

  res.json({ total: results.length, results });
});

module.exports = router;
