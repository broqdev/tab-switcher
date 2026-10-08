import { createServer } from 'node:http';

const titles = {
  '/typescript': 'TypeScript Handbook',
  '/release': 'TypeScript Release Notes',
  '/recipes': 'Dinner Recipes',
  '/other-window': 'Other Window Workspace',
  '/new-tab': 'Freshly Opened Tab',
  '/search/cats': 'Cat Photos',
  '/search/cars': 'Car Insurance',
  '/search/paper-a': '[2610.04518] Length Generalization',
  '/search/paper-b': '[2610.06783v1] Truly Subquadratic Attention',
  '/search/reading': 'Research Library',
  '/search/desk': 'Café Research',
  '/search/handbook': 'ＴｙｐｅＳｃｒｉｐｔ Guide',
};

// Serve actual local pages so even an inactive Chrome-created tab loads reliably.
const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    `<!doctype html><title>${titles[path] || 'Test Tab'}</title><p>Tab fixture</p>`,
  );
});
server.listen(4173, '127.0.0.1');
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
