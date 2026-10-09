# Tab Switcher icon

Generated with the built-in imagegen tool. The exact generation prompt is saved
in [prompt.txt](prompt.txt), and the transparent original is
[tab-switcher-master.png](tab-switcher-master.png).

Run `npm run icons` from the extension directory to export 16, 24, 32, 48, 64,
128, 256, and 512px PNGs to `public/icon/`. Each size is resized directly from the
master using Lanczos3, preserving transparency. The master is a source asset;
only the exported icons are packaged in the extension.

The command also generates `readme-icon.svg`: the same 32px artwork on a 40px
canvas, with 8px of transparent space below it to center it visually beside the
README title. This wrapper is only used in the README.
