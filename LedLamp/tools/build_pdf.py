#!/usr/bin/env python3
"""Build LedLamp.pdf from README.md and docs/*.md.

The Markdown is the source of truth; the PDF is a printable copy of it.
Each document starts on a new page, the SVG drawings in docs/images/ are
inlined so they print, and the Mermaid block is left out (the wiring drawing
shows the same thing).

    python -m pip install -r LedLamp/tools/requirements.txt
    python LedLamp/tools/build_pdf.py          # writes LedLamp/LedLamp.pdf

Needs Chrome, Chromium or Edge; set CHROME=/path/to/browser if it is not found.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

PROJECT = Path(__file__).resolve().parent.parent
ORDER = ["README.md", "docs/brightness.md", "docs/parts-candidates.md",
         "docs/wall-switch.md", "docs/option-b-mains-driver.md"]

CSS = """
@page { size: A4; margin: 14mm 14mm 16mm; }
body { font: 10pt/1.45 "Segoe UI", system-ui, sans-serif; color: #1d2126; }
section { break-after: page; }
section:last-child { break-after: auto; }
h1 { font-size: 20pt; line-height: 1.15; margin: 0 0 8px; }
h2 { font-size: 13.5pt; color: #2f6f8f; margin: 16px 0 4px; }
h3 { font-size: 11pt; margin: 12px 0 4px; }
p, li { margin: 3px 0 6px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 8.6pt; }
th, td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #d9dee4; }
th { background: #f3f5f7; }
a { color: #2f6f8f; text-decoration: none; }
code { font-size: 8.8pt; background: #f3f5f7; padding: 0 3px; border-radius: 3px; }
pre { font-size: 7.6pt; line-height: 1.25; background: #f5f7f9; border: 1px solid #dde2e7;
      border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
figure, .svg { margin: 8px auto 10px; max-width: 100%; }
.svg svg { display: block; margin: 0 auto; max-width: 100%; height: auto; max-height: 230mm; }
hr { border: 0; border-top: 1px solid #d9dee4; margin: 12px 0; }
"""


def inline_images(html, base):
    def repl(m):
        src = m.group(1)
        path = (base / src).resolve()
        if path.suffix != ".svg" or not path.exists():
            return m.group(0)
        svg = path.read_text(encoding="utf-8")
        svg = re.sub(r"^<\?xml[^>]*>\s*", "", svg)
        return '<div class="svg">%s</div>' % svg
    return re.sub(r'<img[^>]*src="([^"]+)"[^>]*>', repl, html)


def render(rel):
    text = (PROJECT / rel).read_text(encoding="utf-8")
    text = re.sub(r"```mermaid\n.*?```\n", "", text, flags=re.S)
    html = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    return inline_images(html, (PROJECT / rel).parent)


def find_browser():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for name in ("google-chrome", "chromium", "chromium-browser", "msedge", "chrome"):
        if shutil.which(name):
            return shutil.which(name)
    for path in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                 r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if os.path.exists(path):
            return path
    sys.exit("no Chrome/Chromium/Edge found; set CHROME=/path/to/browser")


def main():
    body = "\n".join("<section>%s</section>" % render(rel) for rel in ORDER)
    page = ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            "<title>LedLamp</title><style>%s</style></head><body>%s</body></html>" % (CSS, body))
    out = PROJECT / "LedLamp.pdf"
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "LedLamp.html"
        src.write_text(page, encoding="utf-8")
        subprocess.run([find_browser(), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                        "--print-to-pdf=%s" % out, src.as_uri()],
                       check=True, capture_output=True)
    print("wrote %s" % out.relative_to(PROJECT.parent))


if __name__ == "__main__":
    main()
