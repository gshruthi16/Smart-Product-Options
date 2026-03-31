# HS → Shopify Image Pipeline

A Node.js + Express app that automates the full workflow:

**Probe SKUs** → **Download Excel** → **Fill Alt Text** → **Upload to Shopify** → **Generate JSON**

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
```
SHOPIFY_STORE=yourstore.myshopify.com
SHOPIFY_TOKEN=shpat_xxxxxxxxxx
SHOPIFY_API_VERSION=2025-01
PORT=3000
```

### 3. Shopify API token scopes required
In Shopify Admin → Settings → Apps → Develop apps → create app:
- `read_files`
- `write_files`

### 4. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open → **http://localhost:3000**

---

## Workflow

### Step 1 — Probe SKUs
- Enter SKU codes (one per line or comma-separated)
- Select domain (APAC / Global / EU)
- Click **Probe images** → server fetches all views from Humanscale CDN
- Results shown in image grid

### Step 2 — Download Sheet
- Download `humanscale-images.xlsx`
- Open in Excel/Google Sheets
- **Fill in the "Alt Text" column** for each image row
  - Example: `BA-Amber-Plunge-1`, `BA-Amber-Plunge-2`, etc.
  - The JSON key is auto-derived by stripping the trailing `-N`
- Save the file

### Step 3 — Upload to Shopify
- Drag & drop the filled Excel sheet
- Enter Shopify credentials (sidebar)
- Click **Upload to Shopify Files**
- Progress streamed live — images are fetched from Humanscale CDN server-side (no CORS issues) and pushed via Shopify Staged Uploads API
- Download updated sheet with Shopify CDN URLs filled in

### Step 4 — Generate JSON
- Click **Generate JSON**
- Output format:
```json
{
  "BA-Amber-Plunge": [
    "https://cdn.shopify.com/s/files/.../BA-Amber-Plunge-1.jpg",
    "https://cdn.shopify.com/s/files/.../BA-Amber-Plunge-2.jpg",
    "https://cdn.shopify.com/s/files/.../BA-Amber-Plunge-3.jpg"
  ]
}
```
- Copy or download as `gallery-metafield.json`

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/probe` | Probe Humanscale CDN for images by SKU |
| POST | `/api/sheet/generate` | Generate Excel sheet from probe results |
| POST | `/api/upload/from-sheet` | Upload images to Shopify (SSE streaming) |
| POST | `/api/upload/save-sheet` | Save updated sheet with Shopify URLs |
| POST | `/api/json/from-sheet` | Generate JSON from uploaded sheet |
| POST | `/api/json/from-results` | Generate JSON from in-memory results |

---

## Project Structure

```
hs-uploader/
├── server.js              # Express app entry
├── routes/
│   ├── probe.js           # Humanscale CDN image probing
│   ├── sheet.js           # Excel generation
│   ├── upload.js          # Shopify staged upload (SSE)
│   └── json.js            # JSON metafield generation
├── public/
│   └── index.html         # Frontend UI
├── uploads/               # Temp file storage (multer)
├── .env.example
└── package.json
```
