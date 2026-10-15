import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

test('public booking CSP permits only the chosen branded HighLevel frame origin', async () => {
  for (const path of ['/book', '/book.html']) {
    const response = await onRequest({
      request: new Request(`https://easygaragecleaning.com${path}`),
      next: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
    });
    const directives = new Map(response.headers.get('Content-Security-Policy').split(';').map(part => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }));
    assert.ok(directives.get('frame-src').includes('https://links.easygaragecleaning.com'));
    assert.ok(!directives.get('frame-src').includes('https://api.leadconnectorhq.com'));
    assert.ok(!directives.get('frame-src').some(source => source.includes('*')));
    for (const directive of ['script-src', 'connect-src', 'form-action']) {
      assert.ok(!directives.get(directive).some(source => /leadconnector|easygaragecleaning\.com/.test(source)), directive);
    }
    assert.deepEqual(directives.get('form-action'), ["'self'", 'https://api.web3forms.com']);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  }
});
