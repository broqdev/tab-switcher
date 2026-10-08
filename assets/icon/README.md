# Tab Switcher icon

Generated with the built-in imagegen tool. The exact generation prompt is saved
in [prompt.txt](prompt.txt), and the transparent original is
[tab-switcher-master.png](tab-switcher-master.png).

Run `npm run icons` from the extension directory to export 16, 24, 32, 48, 64,
128, 256, and 512px PNGs to `public/icon/`. Each size is resized directly from the
master using Lanczos3, preserving transparency. The master is a source asset;
only the exported icons are packaged in the extension.
