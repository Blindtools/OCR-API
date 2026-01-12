const express = require('express');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const pdfImgConvert = require('pdf-img-convert');
const cors = require('cors');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

// Database initialization
let db;
(async () => {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ocr_jobs (
      id TEXT PRIMARY KEY,
      filename TEXT,
      status TEXT,
      language TEXT,
      result_text TEXT,
      result_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

// Helper function for OCR
async function performOCR(filePath, language = 'eng') {
  const worker = await createWorker(language);
  const { data } = await worker.recognize(filePath);
  await worker.terminate();
  return data;
}

// Endpoints
app.post('/api/ocr/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    const language = req.body.language || 'eng';
    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    await db.run(
      'INSERT INTO ocr_jobs (id, filename, status, language) VALUES (?, ?, ?, ?)',
      [jobId, req.file.originalname, 'processing', language]
    );

    res.status(202).json({ jobId, status: 'processing' });

    // Background processing
    (async () => {
      try {
        let resultText = '';
        let resultJson = [];

        if (fileExt === '.pdf') {
          const pdfImages = await pdfImgConvert.convert(filePath);
          for (let i = 0; i < pdfImages.length; i++) {
            const tempPath = `uploads/temp_${jobId}_${i}.png`;
            fs.writeFileSync(tempPath, pdfImages[i]);
            const data = await performOCR(tempPath, language);
            resultText += data.text + '\n\n';
            resultJson.push({ page: i + 1, ...data });
            fs.unlinkSync(tempPath);
          }
        } else {
          const data = await performOCR(filePath, language);
          resultText = data.text;
          resultJson = [data];
        }

        await db.run(
          'UPDATE ocr_jobs SET status = ?, result_text = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['completed', resultText, JSON.stringify(resultJson), jobId]
        );
      } catch (error) {
        console.error('OCR Processing Error:', error);
        await db.run(
          'UPDATE ocr_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['failed', jobId]
        );
      }
    })();

  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ocr/status/:id', async (req, res) => {
  const job = await db.get('SELECT id, status, created_at, updated_at FROM ocr_jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/ocr/result/:id', async (req, res) => {
  const job = await db.get('SELECT * FROM ocr_jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'Job not completed yet' });
  
  res.json({
    id: job.id,
    filename: job.filename,
    language: job.language,
    text: job.result_text,
    data: JSON.parse(job.result_json),
    accessibility: {
      alt_text: job.result_text.substring(0, 200).replace(/\n/g, ' ') + (job.result_text.length > 200 ? '...' : ''),
      has_text: job.result_text.trim().length > 0,
      language_detected: job.language
    }
  });
});

app.get('/api/ocr/languages', (req, res) => {
  // Tesseract.js supports these common languages and many more
  const languages = [
    { code: 'eng', name: 'English' },
    { code: 'fra', name: 'French' },
    { code: 'deu', name: 'German' },
    { code: 'spa', name: 'Spanish' },
    { code: 'ita', name: 'Italian' },
    { code: 'chi_sim', name: 'Chinese Simplified' },
    { code: 'chi_tra', name: 'Chinese Traditional' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'kor', name: 'Korean' },
    { code: 'rus', name: 'Russian' },
    { code: 'ara', name: 'Arabic' },
    { code: 'hin', name: 'Hindi' }
  ];
  res.json(languages);
});

app.listen(port, () => {
  console.log(`OCR API running at http://localhost:${port}`);
});
