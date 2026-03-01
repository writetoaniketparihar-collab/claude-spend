#!/usr/bin/env node
/**
 * download-fonts.js
 * Downloads the Inter font woff2 files from Google Fonts CDN into
 * src/public/fonts/ so the dashboard can serve them locally.
 *
 * Run once after cloning:  node scripts/download-fonts.js
 * Or add to your workflow: npm run download-fonts
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FONTS_DIR = path.join(__dirname, '..', 'src', 'public', 'fonts');

const FONTS = [
  {
    url: 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2',
    file: 'inter-latin.woff2',
  },
  {
    url: 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2',
    file: 'inter-latin-ext.woff2',
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  }

  for (const { url, file } of FONTS) {
    const dest = path.join(FONTS_DIR, file);
    if (fs.existsSync(dest)) {
      console.log(`  already exists: ${file}`);
      continue;
    }
    process.stdout.write(`  downloading ${file} ...`);
    await download(url, dest);
    console.log(` done (${fs.statSync(dest).size} bytes)`);
  }

  console.log('\nFonts ready. The dashboard will now serve them from /fonts/.');
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
