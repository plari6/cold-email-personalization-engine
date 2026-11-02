const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

/** Fake Gemini client: returns queued answers (strings, objects or Errors) in order. */
function fakeClient(answers) {
  const queue = [...answers];
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(request) {
        calls.push(request);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        const value = typeof next === 'function' ? next(request) : next;
        if (value instanceof Error) throw value;
        return { text: typeof value === 'string' ? value : JSON.stringify(value) };
      },
    },
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cepe-'));

/** Local web server with a few test pages. */
function startSite() {
  const pages = {
    '/': `<html><head><title>Acme Rockets | Reusable rockets for small satellites</title>
      <meta name="description" content="Acme launches small satellites to orbit for 40% less with reusable rockets.">
      </head><body><nav>Home About</nav><h1>Launch smarter</h1><h2>Reusable boosters, weekly launches</h2>
      <p>We have flown 120 missions for university and startup satellite teams since 2019.</p>
      <script>var tracking = 1;</script><footer>© 2024</footer></body></html>`,
    '/empty': '<html><head></head><body><div id="root"></div><script src="app.js"></script></body></html>',
    '/json': '{"a":1}',
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('<h1>late</h1>'), 2000);
    const body = pages[req.url];
    if (body === undefined) {
      res.writeHead(404);
      return res.end('nope');
    }
    res.writeHead(200, { 'Content-Type': req.url === '/json' ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })),
  );
}

module.exports = { fakeClient, tmpDir, startSite };
