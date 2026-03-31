const express = require('express');
const XLSX    = require('xlsx');
const router  = express.Router();

/*
  POST /api/sheet/generate
  Body: { results: [{ sku, view, url }] }
  Returns: Excel file download (.xlsx)

  The sheet has columns:
    SKU | View | Product URL (Humanscale) | Alt Text (fill me in) | Filename | Notes
*/
router.post('/generate', (req, res) => {
  const { results = [] } = req.body;
  if (!results.length) return res.status(400).json({ error: 'No results provided' });

  const wb = XLSX.utils.book_new();

  /* ── Sheet 1: Images to upload ── */
  const rows = results.map(r => ({
    SKU:                r.sku,
    View:               r.view,
    'Product URL':      r.url,
    'Alt Text':         '',           // ← user fills this in
    'Filename':         r.url.split('/').pop(),
    'Shopify URL':      '',           // filled after upload
    'Uploaded':         'NO',
    'Notes':            '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 24 }, // SKU
    { wch: 6  }, // View
    { wch: 70 }, // Product URL
    { wch: 40 }, // Alt Text
    { wch: 32 }, // Filename
    { wch: 70 }, // Shopify URL
    { wch: 10 }, // Uploaded
    { wch: 30 }, // Notes
  ];

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, ws, 'Images');

  /* ── Sheet 2: Instructions ── */
  const instructions = [
    ['Column',       'What to do'],
    ['SKU',          'Auto-filled — do not edit'],
    ['View',         'Auto-filled — image view number'],
    ['Product URL',  'Auto-filled — original Humanscale CDN URL'],
    ['Alt Text',     '★ FILL THIS IN — descriptive alt text for each image (e.g. "Balance chair amber, front view")'],
    ['Filename',     'Auto-filled — original filename'],
    ['Shopify URL',  'Auto-filled after upload — leave blank'],
    ['Uploaded',     'Auto-filled after upload — leave blank'],
    ['Notes',        'Optional — any notes for your team'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(instructions);
  ws2['!cols'] = [{ wch: 18 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

  /* ── Sheet 3: Summary by SKU ── */
  const skuMap = {};
  results.forEach(r => {
    if (!skuMap[r.sku]) skuMap[r.sku] = 0;
    skuMap[r.sku]++;
  });
  const summary = Object.entries(skuMap).map(([sku, count]) => ({ SKU: sku, 'Image Count': count }));
  const ws3 = XLSX.utils.json_to_sheet(summary);
  ws3['!cols'] = [{ wch: 28 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'SKU Summary');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

  res.setHeader('Content-Disposition', 'attachment; filename="humanscale-images.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
