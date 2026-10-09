import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

// GitHub strips CSS offsets. Extra space below the artwork raises its visible
// center when the README aligns the image canvas to the heading's x-height.
const readmeIcon = (await readFile(new URL('128.png', output))).toString(
  'base64',
);
await writeFile(
  new URL('../assets/icon/readme-icon.svg', import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">\n  <image width="32" height="32" href="data:image/png;base64,${readmeIcon}"/>\n</svg>\n`,
);

console.log(`Exported icon PNGs: ${sizes.join(', ')}px.`);
