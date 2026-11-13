// Renders build/icon.svg to build/icon.png (512x512) using Electron.
// Run with: npx electron scripts/make-icon.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SIZE = 512;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<canvas></canvas>');
    // Draw the SVG onto a canvas inside the page and read it back as a PNG data URL.
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.querySelector('canvas');
        c.width = c.height = ${SIZE};
        c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('could not load svg'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote build/icon.png');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
