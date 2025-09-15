'use strict';
/**
 * Advanced Visionless index.js
 * - Supports POST file uploads (multipart/form-data)
 * - Supports GET by URL parameter (download remote image/pdf and process) so you can call from JS fetch GET
 * - Endpoints: /ocr, /describe, /pdf, /docs
 *
 * Environment variables (see .env.example):
 *  PORT=3000
 *  USE_TESSERACT_CLI=true
 *  MAX_FILE_MB=200
 *  LLM_PROVIDER=g4f
 *
 * Note: For production reliability, install tesseract (system) and poppler-utils (pdftoppm).
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const g4f = require('g4f');

const app = express();
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: (process.env.MAX_FILE_MB ? parseInt(process.env.MAX_FILE_MB) : 200) * 1024 * 1024 }
});

const USE_TESSERACT_CLI = (process.env.USE_TESSERACT_CLI || 'true') === 'true';

// helper to download remote URL to a local temp file
async function downloadToFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await axios.get(url, { responseType: 'stream', timeout: 30000 });
  return new Promise((resolve, reject) => {
    resp.data.pipe(writer);
    let error = null;
    writer.on('error', err => { error = err; writer.close(); reject(err); });
    writer.on('close', () => { if (!error) resolve(destPath); });
  });
}

async function analyzeImage(filePath) {
  const img = sharp(filePath);
  const meta = await img.metadata();
  const stats = await img.stats();
  const dominant = (stats && stats.dominant) ? stats.dominant : null;
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    density: meta.density || null,
    dominant,
  };
}

async function ocrImage(filePath, lang='eng') {
  // Prefer Tesseract CLI for speed/quality, if available
  if (USE_TESSERACT_CLI) {
    try {
      const outputBase = filePath + '-ocr';
      const args = [filePath, outputBase, '-l', lang, '--oem', '1', '--psm', '3'];
      const res = spawnSync('tesseract', args, { encoding: 'utf8' });
      // spawnSync stdio suppressed; if tesseract not found, this will throw or return non-zero
      const txtPath = outputBase + '.txt';
      if (fs.existsSync(txtPath)) {
        const txt = fs.readFileSync(txtPath, 'utf8');
        try { fs.unlinkSync(txtPath); } catch(e){ }
        return { text: txt };
      }
    } catch (e) {
      console.warn('tesseract CLI failed, falling back to tesseract.js', e && e.message);
    }
  }

  // fallback: tesseract.js
  const worker = Tesseract.createWorker({ logger: m => { /* console.log(m) */ } });
  await worker.load();
  await worker.loadLanguage(lang);
  await worker.initialize(lang);
  const { data } = await worker.recognize(filePath);
  await worker.terminate();
  return { text: data.text, words: data.words };
}

function pdfToImages(pdfPath, outDir, baseName='p') {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outBase = path.join(outDir, baseName);
  spawnSync('pdftoppm', ['-png', pdfPath, outBase], { stdio: 'inherit' });
  const files = fs.readdirSync(outDir).filter(f => f.startsWith(baseName) && f.endsWith('.png')).map(f => path.join(outDir, f)).sort();
  return files;
}

async function llmSummarize(prompt) {
  try {
    const out = await g4f.call(prompt);
    return out;
  } catch (e) {
    console.error('LLM error', e && e.message);
    return null;
  }
}

// Serve docs
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// utility to get file from either uploaded file or remote url (GET)
async function getFileFromReq(req, fieldName='file') {
  if (req.file) return { path: req.file.path, originalname: req.file.originalname, cleanup: false };
  const url = req.query.url || req.body && req.body.url;
  if (!url) throw new Error('no file uploaded and no url provided (use multipart form field "file" or ?url=...)');
  const ext = path.extname(new URL(url).pathname) || '';
  const tmpName = path.join(UPLOAD_DIR, uuidv4() + (ext || '.bin'));
  await downloadToFile(url, tmpName);
  return { path: tmpName, originalname: url, cleanup: true };
}

// OCR endpoint - supports POST file upload and GET by ?url=
app.all('/ocr', upload.single('file'), async (req, res) => {
  try {
    const lang = (req.query.lang || req.body && req.body.lang || 'eng');
    const file = await getFileFromReq(req);
    const meta = await analyzeImage(file.path);
    const ocr = await ocrImage(file.path, lang);
    if (file.cleanup) try{ fs.unlinkSync(file.path); }catch(e){}
    res.json({ ok: true, file: file.originalname, meta, ocr });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

// Describe endpoint - returns LLM-written description (supports GET ?url=)
app.all('/describe', upload.single('file'), async (req, res) => {
  try {
    const lang = (req.query.lang || req.body && req.body.lang || 'eng');
    const file = await getFileFromReq(req);
    const meta = await analyzeImage(file.path);
    const ocr = await ocrImage(file.path, lang);
    const prompt = [
      "You are a professional image describer and accessibility writer.",
      `Image size: ${meta.width}x${meta.height}, format=${meta.format}.`,
      `OCR excerpt (first 400 chars): ${ocr && ocr.text ? ocr.text.trim().slice(0,400) : '[none]'}
`,
      "Please return a JSON object with fields: caption (one sentence), description (3-5 sentences), alt (<=125 chars), keywords (array)."
    ].join('\n\n');
    const llm = await llmSummarize(prompt);
    if (file.cleanup) try{ fs.unlinkSync(file.path); }catch(e){}
    res.json({ ok:true, file: file.originalname, meta, ocr, llm });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

// PDF endpoint - supports POST upload and GET ?url=
app.all('/pdf', upload.single('file'), async (req, res) => {
  try {
    const file = await getFileFromReq(req);
    const buffer = fs.readFileSync(file.path);
    const parsed = await pdfParse(buffer);
    let out = { file: file.originalname, pages: [], textExtracted: false };
    if (parsed && parsed.text && parsed.text.trim().length > 30) {
      out.textExtracted = true;
      out.text = parsed.text;
    } else {
      // rasterize + OCR
      const imagesDir = path.join(UPLOAD_DIR, 'pdfimgs', uuidv4());
      const imgs = pdfToImages(file.path, imagesDir, 'p');
      for (let i=0;i<imgs.length;i++){
        const p = imgs[i];
        const meta = await analyzeImage(p);
        const ocr = await ocrImage(p, req.query.lang || 'eng');
        out.pages.push({ page: i+1, image: path.basename(p), meta, ocr });
      }
    }
    // ask LLM to summarize (limit)
    const combined = (out.text || out.pages.map(p=> p.ocr && p.ocr.text ? p.ocr.text : '').join('\n\n')).slice(0,4000);
    out.summary = await llmSummarize("Summarize the document in 5 sentences and return keywords:\n\n" + combined);
    if (file.cleanup) try{ fs.unlinkSync(file.path); }catch(e){}
    res.json({ ok:true, result: out });
  } catch (e){
    console.error(e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Visionless index.js running on port', port, 'USE_TESSERACT_CLI=' + USE_TESSERACT_CLI);
});
