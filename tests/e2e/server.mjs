import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 4173;

const INTRO = 'NarraTrace follows each spoken word and keeps the reading position connected to the original article text. This deliberately long opening sentence gives the browser integration test enough time to inspect live word highlighting while the silent test voice advances through the paragraph.';
const PARAGRAPH = 'A reliable reading tool must preserve sentence boundaries, tolerate changing page layouts, and keep its controls responsive while the document changes. The test fixture uses ordinary article markup and local content so browser tests do not depend on an external website.';
const LARGE_PARAGRAPH = 'NarraTrace browser integration tests exercise real extension injection, browser messaging, sentence extraction, and word tracking. The synthetic speech engine emits deterministic word events without producing sound or contacting a remote service.';

function articlePage(paragraphCount = 8) {
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => {
    const id = index === 0 ? 'article-intro' : `article-paragraph-${index + 1}`;
    const text = index === 0 ? INTRO : `${PARAGRAPH} Article section ${index + 1} adds representative text for extraction and queue validation.`;
    return `<p id="${id}">${text}</p>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NarraTrace Browser Integration Article</title>
  <style>
    body { max-width: 900px; margin: 40px auto; padding: 0 24px; font: 18px/1.65 system-ui, sans-serif; }
    aside { margin-top: 32px; padding: 12px; background: #f2f2f2; }
    p { margin: 0 0 1.5rem; }
  </style>
</head>
<body>
  <main>
    <article>
      <h1>NarraTrace Browser Integration</h1>
      ${paragraphs}
    </article>
    <aside id="unrelated-updates">Unrelated page updates appear here.</aside>
  </main>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname;

  if (pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (pathname === '/article') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(articlePage(8));
    return;
  }

  if (pathname === '/large-article') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(articlePage(120).replaceAll(PARAGRAPH, LARGE_PARAGRAPH));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`NarraTrace E2E fixture server listening on http://${HOST}:${PORT}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
