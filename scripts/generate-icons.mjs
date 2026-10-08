import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const master = fileURLToPath(
  new URL('../assets/icon/tab-switcher-master.png', import.meta.url),
);
const output = new URL('../public/icon/', import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const { width, height, hasAlpha } = await sharp(master).metadata();

if (width !== height || width < Math.max(...sizes) || !hasAlpha) {
  throw new Error(
    'Icon master must be square, at least 512px, and have alpha.',
  );
}

await mkdir(output, { recursive: true });
for (const size of sizes) {
  // Resize every export directly from the master, retaining transparent edges.
  await sharp(master)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(fileURLToPath(new URL(`${size}.png`, output)));
}

console.log(`Exported icon PNGs: ${sizes.join(', ')}px.`);
