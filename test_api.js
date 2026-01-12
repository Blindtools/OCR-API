const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const API_URL = 'http://localhost:3000/api/ocr';

async function testOCR() {
  try {
    console.log('Starting OCR API Test...');

    // 1. Check languages
    const langRes = await axios.get(`${API_URL}/languages`);
    console.log('Supported Languages:', langRes.data.length);

    // 2. Upload a test image
    console.log('Uploading test image...');
    const form = new FormData();
    form.append('file', fs.createReadStream('/home/ubuntu/ocr-api/test_image.png'));
    form.append('language', 'eng');

    const uploadRes = await axios.post(`${API_URL}/upload`, form, {
      headers: form.getHeaders()
    });
    const jobId = uploadRes.data.jobId;
    console.log('Upload successful, Job ID:', jobId);

    // 3. Poll for results
    console.log('Polling for results...');
    let status = 'processing';
    while (status === 'processing') {
      const statusRes = await axios.get(`${API_URL}/status/${jobId}`);
      status = statusRes.data.status;
      if (status === 'processing') {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (status === 'completed') {
      const resultRes = await axios.get(`${API_URL}/result/${jobId}`);
      console.log('OCR Result:', resultRes.data.text.trim());
      console.log('Accessibility Alt Text:', resultRes.data.accessibility.alt_text);
    } else {
      console.log('OCR Job failed with status:', status);
    }

  } catch (error) {
    console.error('Test Failed:', error.message);
  }
}

testOCR();
