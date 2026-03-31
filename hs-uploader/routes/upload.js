const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const router   = express.Router();

const upload = multer({ dest: 'uploads/' });

/* ════════════════════════════════════════════════════
   Helper: call Shopify GraphQL
════════════════════════════════════════════════════ */
async function shopifyGQL(store, token, version, query, variables = {}) {
  const url = `https://${store}/admin/api/${version}/graphql.json`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':            'application/json',
      'X-Shopify-Access-Token':  token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GQL HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

/* ════════════════════════════════════════════════════
   POST /api/upload/from-sheet
   Multipart: file (xlsx) + store + token + version
   Streams SSE progress back to client
════════════════════════════════════════════════════ */
router.post('/from-sheet', upload.single('file'), async (req, res) => {
  const { store, token, version = '2025-01' } = req.body;
  if (!store || !token)  return res.status(400).json({ error: 'Missing store or token' });
  if (!req.file)         return res.status(400).json({ error: 'No Excel file uploaded' });

  /* Parse Excel */
  const wb   = XLSX.readFile(req.file.path);
  const ws   = wb.Sheets['Images'];
  if (!ws) return res.status(400).json({ error: 'Sheet "Images" not found in workbook' });

  const rows = XLSX.utils.sheet_to_json(ws);
  if (!rows.length) return res.status(400).json({ error: 'Images sheet is empty' });

  /* SSE setup — stream progress */
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const toUpload = rows.filter(r => r['Product URL'] && r['Uploaded'] !== 'YES');
  send('info', { msg: `Starting upload of ${toUpload.length} images to ${store}` });

  const BATCH = 5;
  let ok = 0, err = 0;
  const updatedRows = [...rows];

  for (let i = 0; i < toUpload.length; i += BATCH) {
    const batch = toUpload.slice(i, i + BATCH);

    /* ── STEP 1: Request staged upload targets ── */
    const stagedInputs = batch.map(r => ({
      resource:   'IMAGE',
      filename:   r['Filename'] || r['Product URL'].split('/').pop(),
      mimeType:   r['Product URL'].endsWith('.png') ? 'image/png' : 'image/jpeg',
      httpMethod: 'POST',
    }));

    let targets;
    try {
      const data = await shopifyGQL(store, token, version,
        `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){
           stagedUploadsCreate(input:$input){
             stagedTargets{ url resourceUrl parameters{ name value } }
             userErrors{ field message }
           }
         }`,
        { input: stagedInputs }
      );

      const ue = data?.data?.stagedUploadsCreate?.userErrors || [];
      if (ue.length) throw new Error(ue.map(e => `${e.field}: ${e.message}`).join(', '));
      targets = data?.data?.stagedUploadsCreate?.stagedTargets || [];
    } catch (e) {
      send('error', { msg: `Staged create failed: ${e.message}` });
      err += batch.length; continue;
    }

    /* ── STEP 2: Fetch image + POST to staged target ── */
    for (let j = 0; j < batch.length; j++) {
      const row    = batch[j];
      const target = targets[j];
      const alt    = row['Alt Text'] || row['Filename'] || '';

      if (!target) { err++; continue; }

      try {
        /* Fetch image bytes from Humanscale CDN */
        const imgRes = await fetch(row['Product URL'], { timeout: 15000 });
        if (!imgRes.ok) throw new Error(`Image fetch HTTP ${imgRes.status}`);
        const imgBuf = await imgRes.buffer();

        /* POST to Google Cloud Storage staged target */
        const form = new FormData();
        (target.parameters || []).forEach(p => form.append(p.name, p.value));
        form.append('file', imgBuf, {
          filename:    stagedInputs[j].filename,
          contentType: stagedInputs[j].mimeType,
        });

        const putRes = await fetch(target.url, { method: 'POST', body: form });
        if (!putRes.ok) {
          const t = await putRes.text();
          throw new Error(`GCS upload HTTP ${putRes.status}: ${t.substring(0, 120)}`);
        }

        /* ── STEP 3: Confirm fileCreate with alt text ── */
        const confirmData = await shopifyGQL(store, token, version,
          `mutation fileCreate($files:[FileCreateInput!]!){
             fileCreate(files:$files){
               files{ id alt ... on MediaImage{ image{ url } } }
               userErrors{ field message }
             }
           }`,
          { files: [{ originalSource: target.resourceUrl, alt, contentType: 'IMAGE' }] }
        );

        const ue2 = confirmData?.data?.fileCreate?.userErrors || [];
        if (ue2.length) throw new Error(ue2.map(e => e.message).join(', '));

        const shopifyUrl = confirmData?.data?.fileCreate?.files?.[0]?.image?.url
                          || target.resourceUrl;

        /* Mark row as uploaded */
        const rowIdx = updatedRows.findIndex(r => r['Product URL'] === row['Product URL']);
        if (rowIdx !== -1) {
          updatedRows[rowIdx]['Shopify URL'] = shopifyUrl;
          updatedRows[rowIdx]['Uploaded']    = 'YES';
        }

        ok++;
        send('progress', {
          done: ok + err,
          total: toUpload.length,
          msg:  `✓ ${alt || stagedInputs[j].filename}`,
          shopifyUrl,
          originalUrl: row['Product URL'],
        });

      } catch (e) {
        err++;
        send('error', { msg: `✗ ${row['Product URL'].split('/').pop()}: ${e.message}` });
      }
    }

    // Small delay between batches to respect Shopify rate limits
    if (i + BATCH < toUpload.length) await sleep(800);
  }

  send('done', { ok, err, total: toUpload.length, rows: updatedRows });
  res.end();
});

/* ════════════════════════════════════════════════════
   POST /api/upload/save-sheet
   Body: { rows: [...] }  — save updated rows back to xlsx
════════════════════════════════════════════════════ */
router.post('/save-sheet', (req, res) => {
  const { rows = [] } = req.body;
  if (!rows.length) return res.status(400).json({ error: 'No rows' });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 24 }, { wch: 6  }, { wch: 70 }, { wch: 40 },
    { wch: 32 }, { wch: 70 }, { wch: 10 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Images');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Disposition', 'attachment; filename="humanscale-uploaded.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = router;
