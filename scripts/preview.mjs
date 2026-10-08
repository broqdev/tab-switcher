import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(directory, '../.output/chrome-mv3');
const port = 4174;
const previewHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tab Switcher · Popup preview</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #202322; color: #dfe6e1; font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    main { width: 400px; margin: 16px auto; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    h1 { margin: 0; font-size: 13px; font-weight: 500; }
    button { border: 0; padding: 4px 0; background: transparent; color: #a6b5ab; font: inherit; font-size: 11px; cursor: pointer; }
    iframe { display: block; width: 400px; height: 600px; border: 0; border-radius: 12px; box-shadow: 0 2px 8px #0006; }
    p { margin-top: 12px; color: #a6b5ab; font-size: 11px; line-height: 1.6; }
  </style>
  <main>
    <header><h1>Tab Switcher</h1><button id="reset">Reset preview</button></header>
    <iframe title="Extension popup" src="/popup.html"></iframe>
    <p>Sample open and closed tabs.<br>Search and keyboard selection work.</p>
  </main>
  <script>
    const frame = document.querySelector('iframe');
    let resize;
    frame.addEventListener('load', () => {
      resize?.disconnect();
      resize = new ResizeObserver(() => {
        frame.style.height = Math.ceil(frame.contentDocument.body.getBoundingClientRect().height) + 'px';
      });
      resize.observe(frame.contentDocument.body);
    });
    document.querySelector('#reset').addEventListener('click', () => frame.contentWindow.location.reload());
  </script>
</html>`;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', mimeTypes['.html']);
      response.end(previewHtml);
    } else if (url.pathname === '/popup.html') {
      const pageHtml = await readFile(
        resolve(output, url.pathname.slice(1)),
        'utf8',
      );
      response.setHeader('Content-Type', mimeTypes['.html']);
      response.end(
        pageHtml.replace(
          '<head>',
          '<head><script src="/preview-data.js"></script>',
        ),
      );
    } else if (url.pathname === '/preview-data.js') {
      response.setHeader('Content-Type', mimeTypes['.js']);
      response.end(await readFile(resolve(directory, 'preview-data.js')));
    } else if (url.pathname === '/_favicon/') {
      const hostname = new URL(
        url.searchParams.get('pageUrl') || 'https://example.com',
      ).hostname;
      const icons = {
        'www.zhihu.com': ['#0084ff', '知'],
        'arxiv.org': ['#b85a51', 'A'],
        'github.com': ['#dce6df', 'G'],
        'huggingface.co': ['#e3c354', '●'],
        'www.google.com': ['#739ce2', 'G'],
      };
      const [color, letter] = icons[hostname] || ['#90ae99', '●'];
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="1" y="1" width="14" height="14" rx="4" fill="${color}"/><text x="8" y="11.5" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="#183720">${letter}</text></svg>`,
      );
    } else {
      const path = resolve(output, `.${decodeURIComponent(url.pathname)}`);
      const mime = mimeTypes[extname(path)];
      if (!path.startsWith(output + sep) || !mime) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', mime);
      response.end(await readFile(path));
    }
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Popup preview: http://127.0.0.1:${port}`);
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
