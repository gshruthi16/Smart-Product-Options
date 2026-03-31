const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const router   = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ 
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed'));
    }
  }
});

/* ════════════════════════════════════════════════════
   Helper: call Shopify GraphQL
════════════════════════════════════════════════════ */
async function shopifyGQL(store, token, version, query, variables = {}) {
  // Normalize store domain
  let normalizedStore = store.trim();
  if (!normalizedStore.includes('.')) normalizedStore += '.myshopify.com';
  if (normalizedStore.startsWith('https://')) normalizedStore = normalizedStore.replace('https://', '');
  if (normalizedStore.startsWith('http://')) normalizedStore = normalizedStore.replace('http://', '');
  
  const url = `https://${normalizedStore}/admin/api/${version}/graphql.json`;
  
  console.log(`[SHOPIFY] POST ${url}`);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      timeout: 30000,
    });

    const responseText = await res.text();
    
    if (!res.ok) {
      console.error(`[SHOPIFY] HTTP ${res.status}: ${responseText.substring(0, 300)}`);
      throw new Error(`Shopify HTTP ${res.status}: ${responseText.substring(0, 150)}`);
    }
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error(`[SHOPIFY] Invalid JSON response: ${responseText.substring(0, 200)}`);
      throw new Error('Invalid JSON response from Shopify');
    }
    
    // Check for GraphQL errors
    if (data.errors && data.errors.length > 0) {
      const errMsg = data.errors.map(e => e.message).join('; ');
      console.error(`[SHOPIFY] GraphQL error: ${errMsg}`);
      throw new Error(`Shopify error: ${errMsg}`);
    }
    
    return data;
  } catch (e) {
    console.error(`[SHOPIFY] Exception: ${e.message}`);
    throw e;
  }
}

/* ════════════════════════════════════════════════════
   POST /api/upload/validate
   Validate Shopify credentials before uploading
════════════════════════════════════════════════════ */
router.post('/validate', async (req, res) => {
  const { store, token, version = '2025-01' } = req.body;
  
  if (!store || !token) {
    return res.status(400).json({ error: 'Missing store or token' });
  }
  
  try {
    const data = await shopifyGQL(store, token, version, `{ shop { name id } }`);
    
    if (data.data?.shop?.name) {
      console.log(`[SHOPIFY] ✓ Connected to shop: ${data.data.shop.name}`);
      res.json({ valid: true, shop: data.data.shop.name });
    } else {
      res.status(401).json({ valid: false, error: 'Invalid credentials' });
    }
  } catch (e) {
    console.error(`[SHOPIFY] Validation failed: ${e.message}`);
    res.status(401).json({ valid: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════
   POST /api/upload/from-sheet
   Multipart: file (xlsx) + store + token + version
   Streams SSE progress back to client
════════════════════════════════════════════════════ */
router.post('/from-sheet', upload.single('file'), async (req, res) => {
  const { store, token, version = '2025-01' } = req.body;
  const uploadedFilePath = req.file?.path;
  
  if (!store || !token) {
    if (uploadedFilePath) fs.unlink(uploadedFilePath, () => {});
    return res.status(400).json({ error: 'Missing store or token' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No Excel file uploaded' });
  }

  try {
    /* Parse Excel */
    let wb, ws, rows;
    try {
      wb = XLSX.readFile(req.file.path);
      ws = wb.Sheets['Images'];
      if (!ws) {
        throw new Error('Sheet "Images" not found in workbook');
      }
      rows = XLSX.utils.sheet_to_json(ws);
      if (!rows.length) {
        throw new Error('Images sheet is empty');
      }
    } catch (parseErr) {
      if (uploadedFilePath) fs.unlink(uploadedFilePath, () => {});
      return res.status(400).json({ error: `Excel parse error: ${parseErr.message}` });
    }

    /* SSE setup — stream progress */
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const send = (type, data) => {
      try {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      } catch (e) {
        console.error(`[UPLOAD] SSE write error: ${e.message}`);
      }
    };

    const toUpload = rows.filter(r => r['Product URL'] && r['Uploaded'] !== 'YES');
    console.log(`[UPLOAD] Starting upload of ${toUpload.length} images to ${store}`);
    send('info', { msg: `Starting upload of ${toUpload.length} images to ${store}` });

    const BATCH = 3; // Reduced batch size for better reliability
    let ok = 0, err = 0;
    const updatedRows = [...rows];

    for (let i = 0; i < toUpload.length; i += BATCH) {
      const batch = toUpload.slice(i, i + BATCH);
      console.log(`[UPLOAD] Processing batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(toUpload.length / BATCH)}`);

      /* ── STEP 1: Request staged upload targets ── */
      const stagedInputs = batch.map(r => ({
        resource: 'IMAGE',
        filename: r['Filename'] || r['Product URL'].split('/').pop(),
        mimeType: r['Product URL'].endsWith('.png') ? 'image/png' : 'image/jpeg',
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
        if (ue.length) {
          const errMsg = ue.map(e => `${e.field}: ${e.message}`).join(', ');
          throw new Error(errMsg);
        }
        targets = data?.data?.stagedUploadsCreate?.stagedTargets || [];
        
        if (!targets.length) {
          throw new Error('No staged upload targets returned');
        }
        
        console.log(`[UPLOAD] Got ${targets.length} staging URLs`);
      } catch (e) {
        console.error(`[UPLOAD] Staged create failed: ${e.message}`);
        send('error', { msg: `Staged upload failed: ${e.message}` });
        err += batch.length;
        continue;
      }

      /* ── STEP 2: Fetch image + POST to staged target ── */
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const target = targets[j];
        const alt = row['Alt Text'] || row['Filename'] || 'Product image';

        if (!target) {
          err++;
          console.error(`[UPLOAD] No target for ${row['Filename']}`);
          send('error', { msg: `No staging target for ${row['Filename']}` });
          continue;
        }

        try {
          /* Fetch image bytes from Humanscale CDN */
          console.log(`[UPLOAD] Fetching ${row['Product URL'].substring(0, 80)}`);
          const imgRes = await fetch(row['Product URL'], { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'image/*', 'Referer': 'https://apac.humanscale.com/' } });
          if (!imgRes.ok) throw new Error(`Image fetch HTTP ${imgRes.status}`);
          const imgBuf = await imgRes.buffer();
          console.log(`[UPLOAD] Got ${imgBuf.length} bytes`);

          /* POST to Google Cloud Storage staged target */
          const form = new FormData();
          (target.parameters || []).forEach(p => form.append(p.name, p.value));
          form.append('file', imgBuf, {
            filename: stagedInputs[j].filename,
            contentType: stagedInputs[j].mimeType,
          });

          console.log(`[UPLOAD] Uploading to GCS: ${target.url.substring(0, 80)}`);
          const putRes = await fetch(target.url, { method: 'POST', body: form, timeout: 30000 });
          if (!putRes.ok) {
            const t = await putRes.text();
            throw new Error(`GCS upload HTTP ${putRes.status}: ${t.substring(0, 120)}`);
          }
          console.log(`[UPLOAD] ✓ GCS upload successful`);

          /* ── STEP 3: Confirm fileCreate with alt text ── */
          console.log(`[UPLOAD] Creating file record in Shopify with alt: ${alt}`);
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

          const shopifyUrl = confirmData?.data?.fileCreate?.files?.[0]?.image?.url || target.resourceUrl;

          /* Mark row as uploaded */
          const rowIdx = updatedRows.findIndex(r => r['Product URL'] === row['Product URL']);
          if (rowIdx !== -1) {
            updatedRows[rowIdx]['Shopify URL'] = shopifyUrl;
            updatedRows[rowIdx]['Uploaded'] = 'YES';
          }

          ok++;
          console.log(`[UPLOAD] ✓ Complete: ${alt}`);
          send('progress', {
            done: ok + err,
            total: toUpload.length,
            msg: `✓ ${alt}`,
            shopifyUrl,
            originalUrl: row['Product URL'],
          });

        } catch (e) {
          err++;
          console.error(`[UPLOAD] ✗ Error: ${e.message}`);
          send('error', { msg: `✗ ${row['Product URL'].split('/').pop()}: ${e.message}` });
        }
      }

      // Delay between batches
      if (i + BATCH < toUpload.length) {
        console.log(`[UPLOAD] Waiting before next batch...`);
        await sleep(1000);
      }
    }

    console.log(`[UPLOAD] ✓ Complete: ${ok} uploaded, ${err} errors`);
    send('done', { ok, err, total: toUpload.length, rows: updatedRows });
    res.end();

  } catch (e) {
    console.error(`[UPLOAD] Fatal error: ${e.message}`);
    send('error', { msg: `Upload failed: ${e.message}` });
    res.end();
  } finally {
    // Clean up uploaded file
    setTimeout(() => {
      if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
        fs.unlink(uploadedFilePath, err => {
          if (err) console.error(`[UPLOAD] Cleanup failed: ${err.message}`);
          else console.log(`[UPLOAD] Cleaned up temp file`);
        });
      }
    }, 1000);
  }
});

/* ════════════════════════════════════════════════════
   POST /api/upload/save-sheet
   Body: { rows: [...] }  — save updated rows back to xlsx
════════════════════════════════════════════════════ */
router.post('/save-sheet', (req, res) => {
  const { rows = [] } = req.body;
  if (!rows.length) return res.status(400).json({ error: 'No rows' });

  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 24 }, { wch: 6 }, { wch: 70 }, { wch: 40 },
      { wch: 32 }, { wch: 70 }, { wch: 10 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Images');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Disposition', 'attachment; filename="humanscale-uploaded.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `Failed to save sheet: ${e.message}` });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = router;
