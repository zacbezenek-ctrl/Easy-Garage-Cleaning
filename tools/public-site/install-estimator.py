"""Idempotent integration, also called by the existing site generator."""
from pathlib import Path
import re
ROOT = Path(__file__).resolve().parents[2]
PAGES = ('index.html', 'pricing.html', 'junk-removal-fort-collins-co.html', 'fort-collins-junk-removal.html')
def install():
    markup = (ROOT / 'tools/public-site/load-estimator.fragment').read_text()
    for name in PAGES:
        path = ROOT / name
        text = path.read_text()
        text = re.sub(r'\n?<!-- LOAD ESTIMATOR START -->.*?<!-- LOAD ESTIMATOR END -->\n?', '', text, flags=re.S)
        text = text.replace('</head>', '<link rel="stylesheet" href="/public-load-estimator.css?v=20261001">\n</head>') if '/public-load-estimator.css' not in text else text
        text = text.replace('</body>', '<script type="module" src="/public-load-estimator.js?v=20261001"></script>\n</body>') if '/public-load-estimator.js' not in text else text
        marker = '<!-- LOAD ESTIMATOR START -->\n' + markup + '<!-- LOAD ESTIMATOR END -->\n'
        hero = re.search(r'<(header|section)\b[^>]*class="[^"]*\bhero\b[^"]*"[^>]*>.*?</\1>', text, re.S)
        if not hero:
            raise ValueError(f'{name}: hero section missing')
        text = text[:hero.end()] + '\n' + marker + text[hero.end():]
        path.write_text(text)
if __name__ == '__main__': install()
