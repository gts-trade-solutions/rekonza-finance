// Derives every brand asset from public/logo.png.
//   node scripts/brand-assets.mjs
//
// The master file is a wide navy-and-teal lockup on transparency. Six things
// come out of it, and all of them are regenerated here rather than hand-edited,
// so a new master only has to be dropped in and this re-run.
//
//   mark.png            the glyph alone, squared, for narrow chrome slots
//   wordmark.png        the lockup with its whitespace trimmed
//   mark-dark.png       ┐ the same two with the navy recoloured to near-white,
//   wordmark-dark.png   ┘ because a navy wordmark on a dark ground is invisible
//   app/icon.png        the favicon Next.js picks up by convention
//   app/favicon.ico     the same, for the handful of clients that want an .ico
//   app/apple-icon.png  the same on white, since Apple ignores transparency
//
// The dark variants are a per-pixel recolour rather than a filter: inverting or
// brightening the whole image would take the teal and the blue with it, and
// those are the half of the mark that already reads on a dark ground.

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const SRC = 'public/logo.png';

/** Where the glyph sits in the master, and where the lockup ends. */
const GLYPH = { left: 62, top: 152, width: 492, height: 376 };
const LOCKUP = { left: 62, top: 152, width: 1940, height: 376 };

/** What the navy becomes on a dark ground: the app's own light foreground. */
const ON_DARK = [232, 237, 245];

/**
 * Repaint the navy, leave everything else alone.
 *
 * Navy in this artwork is (0,32,80) through (0,32,112) — no red, little green,
 * and a blue channel well below the accent blue's 240. The teal sits at g≈200
 * and the accent blue at b=240, so both fall outside the test. Antialiased
 * edges keep their alpha and only change hue, which is what stops the recolour
 * showing as a halo.
 */
async function recolour(inputPath, outputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const isNavy = r < 70 && g < 100 && b < 150 && b > g;
    if (!isNavy) continue;
    data[i] = ON_DARK[0];
    data[i + 1] = ON_DARK[1];
    data[i + 2] = ON_DARK[2];
  }

  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outputPath);
  console.log('wrote', outputPath);
}

// ── The two light-ground assets ─────────────────────────────────────────────
await sharp(SRC)
  .extract(GLYPH)
  .resize(440, 336, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({
    top: 88, bottom: 88, left: 36, right: 36,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .resize(512, 512)
  .png()
  .toFile('public/mark.png');
console.log('wrote public/mark.png');

await sharp(SRC).extract(LOCKUP).png().toFile('public/wordmark.png');
console.log('wrote public/wordmark.png');

// ── Their dark-ground twins ─────────────────────────────────────────────────
await recolour('public/mark.png', 'public/mark-dark.png');
await recolour('public/wordmark.png', 'public/wordmark-dark.png');

// ── Icons ───────────────────────────────────────────────────────────────────
await sharp('public/mark.png').resize(512, 512).png().toFile('app/icon.png');
console.log('wrote app/icon.png');

await sharp('public/mark.png')
  .resize(160, 160)
  .extend({ top: 10, bottom: 10, left: 10, right: 10, background: '#ffffff' })
  .flatten({ background: '#ffffff' })
  .png()
  .toFile('app/apple-icon.png');
console.log('wrote app/apple-icon.png');

// ── favicon.ico ─────────────────────────────────────────────────────────────
//
// The ICO container has allowed a PNG payload since Vista, so this is a 22-byte
// header wrapped around a 32x32 PNG rather than a real bitmap encoder. Written
// because Next serves app/favicon.ico ahead of app/icon.png, and the file that
// shipped with the project template was still the Next.js logo.
{
  const png = await sharp('public/mark.png').resize(32, 32).png().toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(1, 4);          // one image
  header.writeUInt8(32, 6);            // width
  header.writeUInt8(32, 7);            // height
  header.writeUInt8(0, 8);             // palette size: none
  header.writeUInt8(0, 9);             // reserved
  header.writeUInt16LE(1, 10);         // colour planes
  header.writeUInt16LE(32, 12);        // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);        // offset of the payload
  writeFileSync('app/favicon.ico', Buffer.concat([header, png]));
  console.log('wrote app/favicon.ico');
}
