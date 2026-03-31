const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const router  = express.Router();

const upload = multer({ dest: 'uploads/' });

/*
  POST /api/json/from-sheet
  Multipart: file (xlsx with Shopify URLs filled)
  Returns JSON in format:
  {
    "KEY-NAME": ["https://cdn.shopify.com/...", ...],
    ...
  }
*/
router.post('/from-sheet', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { keyMode = 'altbase' } = req.body;
  // keyMode options:
  //   altbase  — strip last "-N" from alt text  (e.g. "BA-Amber-Plunge-2" → "BA-Amber-Plunge")
  //   sku      — use SKU column directly
  //   prefix   — use first word of alt text

  const wb = XLSX.readFile(req.file.path);
  const ws = wb.Sheets['Images'];
  if (!ws) return res.status(400).json({ error: 'Sheet "Images" not found' });

  const rows = XLSX.utils.sheet_to_json(ws);

  const map = {};

  rows.forEach(row => {
    const url = row['Shopify URL'] || row['Product URL'];
    if (!url) return;

    let key;
    if (keyMode === 'sku') {
      key = (row['SKU'] || '').trim();
    } else if (keyMode === 'prefix') {
      key = (row['Alt Text'] || '').trim().split(/[\s-]/)[0];
    } else {
      // altbase: strip trailing -N from alt text
      const alt = (row['Alt Text'] || row['SKU'] || '').trim();
      key = alt.replace(/-\d+$/, '');
    }

    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(url);
  });

  // Sort URLs within each key by natural order
  Object.keys(map).forEach(k => {
    map[k].sort((a, b) => {
      const numA = parseInt((a.match(/-(\d+)\.\w+/) || [])[1] || 0);
      const numB = parseInt((b.match(/-(\d+)\.\w+/) || [])[1] || 0);
      return numA - numB;
    });
  });

  res.json(map);
});

/*
  POST /api/json/from-results
  Body: { results: [{ sku, view, url, shopifyUrl, altText }], keyMode }
  Returns JSON metafield object — no file needed
*/
router.post('/from-results', (req, res) => {
  const { results = [], keyMode = 'altbase' } = req.body;
  const map = {};

  results.forEach(r => {
    const url = r.shopifyUrl || r.url;
    let key;

    if (keyMode === 'sku')       key = r.sku;
    else if (keyMode === 'prefix') key = (r.altText || '').split(/[\s-]/)[0] || r.sku;
    else {
      // altbase
      const alt = r.altText || r.sku;
      key = alt.replace(/-\d+$/, '');
    }

    if (!map[key]) map[key] = [];
    map[key].push(url);
  });

  res.json(map);
});

module.exports = router;
