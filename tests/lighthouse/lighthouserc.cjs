/* Mobile Lighthouse CI for the public site, the customer and business portals, and the crew Today screen. See docs/lighthouse-ci.md. */
const { readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = join(__dirname, '..', '..');
const port = Number(process.env.LIGHTHOUSE_PORT) || 9393;
const origin = `http://127.0.0.1:${port}`;
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

// Pages Function file that routes /client-login in Cloudflare Pages: functions/client-login.js,
// functions/client-login/index.js or an optional catch-all such as functions/client-login/[[path]].js. serve.mjs runs it.
function clientLoginFunction(base = root) {
  const functions = join(base, 'functions'), candidates = [join(functions, 'client-login.js'), join(functions, 'client-login', 'index.js')];
  try { candidates.push(...readdirSync(join(functions, 'client-login')).filter(name => /^\[\[[^\]/]+\]\]\.js$/.test(name)).sort().map(name => join(functions, 'client-login', name))); } catch { /* no functions/client-login/ folder */ }
  return candidates.find(isFile) || null;
}

// Client Login is audited as soon as it ships in any shape Cloudflare Pages serves: client-login.html or a Pages Function
// (/client-login), or client-login/index.html (/client-login/). Until then it stays in `pending`, and the job summary lists
// it as not measured; auditing a 404 would only abort the run.
function clientLoginPath(base = root) {
  if (isFile(join(base, 'client-login.html')) || clientLoginFunction(base)) return '/client-login';
  return isFile(join(base, 'client-login', 'index.html')) ? '/client-login/' : null;
}

// Reports default to test-results/lighthouse (gitignored and skipped by tests/source-files.mjs), so a local run never adds
// files that the root suite scans. LIGHTHOUSE_REPORT_DIR overrides it, relative to the working directory like lhci itself.
const reportDirFor = (env = process.env) => env.LIGHTHOUSE_REPORT_DIR ? resolve(env.LIGHTHOUSE_REPORT_DIR) : join(root, 'test-results', 'lighthouse');

const clientLogin = clientLoginPath();
const paths = [
  '/', '/garage-cleanouts-fort-collins-co', '/junk-removal-loveland-co', '/couch-removal-fort-collins-co', '/book', '/pricing',
  '/blog/how-much-does-garage-cleanout-cost-fort-collins', '/garage-turnaround-fort-collins-co', '/before-after',
  ...(clientLogin ? [clientLogin] : []),
  '/customer-portal', '/business-hub', '/field-today',
];
// Pages the mission requires that do not exist in this checkout yet; the summary shows them as not measured.
const pending = clientLogin ? [] : ['/client-login'];
const minScore = 0.9;
const reportDir = reportDirFor();

module.exports = {
  paths, pending, port, origin, minScore, reportDir, clientLoginFunction, clientLoginPath, reportDirFor,
  ci: {
    collect: {
      startServerCommand: `node ${JSON.stringify(join(__dirname, 'serve.mjs'))}`,
      startServerReadyPattern: 'EGC Lighthouse server listening on',
      startServerReadyTimeout: 20000,
      url: paths.map(path => origin + path),
      numberOfRuns: 3,
      settings: {
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 3, disabled: false },
        throttlingMethod: 'simulate',
        onlyCategories: ['performance', 'accessibility'],
        blockedUrlPatterns: ['*googletagmanager.com*', '*connect.facebook.net*', '*clarity.ms*'],
        // Containers run Chrome as root, which requires disabling the sandbox; CI runners keep it.
        ...(process.getuid?.() === 0 ? { chromeFlags: '--no-sandbox' } : {}),
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore, aggregationMethod: 'median' }],
        'categories:accessibility': ['error', { minScore, aggregationMethod: 'median' }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: reportDir,
    },
  },
};
