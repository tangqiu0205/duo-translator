// Generate extension and macOS app icons from the shared SVG.
// Uses the same Playwright Chromium dependency as translated-icon.mjs.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const logo = readFileSync(new URL('public/DuoTranslator.svg', root), 'utf8');
// Trim the brand artwork's outer padding for the browser's fixed 16px slot.
const toolbar = logo.replace('viewBox="0 0 1024 1024"', 'viewBox="48 64 928 928"');
const glyph = logo.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x2="0" y2="1">
      <stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#E6F2FF"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dy="8" stdDeviation="12" flood-opacity=".28"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#tile)" filter="url(#shadow)"/>
  <g transform="translate(223.6 213.6) scale(.56328125)">${glyph}</g>
</svg>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [art, sizes, directory, prefix] of [
    [toolbar, [16, 32, 48, 96, 128], 'public/icon/', ''],
    [app, [16, 32, 64, 128, 256, 512, 1024], 'safari/App/Assets.xcassets/AppIcon.appiconset/', 'icon_'],
  ]) {
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<body style="margin:0;background:transparent">${art.replace(/<svg[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, '').replace('<svg', '<svg width="100%" height="100%"'))}</body>`);
      const png = await page.screenshot({ omitBackground: true });
      const target = new URL(`${directory}${prefix}${size}.png`, root);
      writeFileSync(target, png);
      console.log(fileURLToPath(target));
    }
  }
} finally {
  await browser.close();
}
