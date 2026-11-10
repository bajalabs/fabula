#!/bin/sh
# The engine drill, run inside the image as its own user: `docker run --rm fabula sh scripts/engine-drill.sh`.
# Each engine reports its version, then renders one small document; a PDF must start with %PDF and an MJML render
# must contain a table. Any failure exits non-zero and names the engine.
set -eu
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
cd "$D"
pdf() { head -c 4 "$1" | grep -q '%PDF' || { echo "drill: $2 did not write a PDF"; exit 1; }; echo "drill: $2 ok ($(wc -c < "$1") bytes)"; }

echo "drill: typst $(typst --version)"
echo "drill: pandoc $(pandoc --version | head -1)"
echo "drill: quarto $(quarto --version)"
echo "drill: weasyprint $(weasyprint --version)"
echo "drill: poppler $(pdftoppm -v 2>&1 | head -1)"
echo "drill: node $(node --version), mjml $(node -p "require('/app/node_modules/mjml/package.json').version")"

# Typst, as Fabula calls it (compile to stdout), with a cached package
cat > main.typ <<'TYP'
#import "@preview/cetz:0.5.3"
#set text(font: "Noto Sans", lang: "en")
#let brand = (name: "Brand", primary: rgb("#0E7C66"))
#text(fill: brand.primary)[= #brand.name]
Café, naïve, façade — 100 % · €
#cetz.canvas({ import cetz.draw: *; circle((0, 0), radius: 0.5) })
TYP
typst compile main.typ - --root "$D" --package-path "$TYPST_PACKAGE_CACHE_PATH" > typst.pdf
pdf typst.pdf typst

# Pandoc to PDF through Typst
printf '# Sheet\n\nA list:\n\n- one\n- two\n' > doc.md
pandoc doc.md --pdf-engine=typst --variable mainfont="Noto Sans" --standalone --output=pandoc.pdf
pdf pandoc.pdf pandoc

# Quarto to PDF through Typst, no cache
printf -- '---\ntitle: "Report"\nformat: typst\n---\n\nText with **bold**.\n' > report.qmd
quarto render report.qmd --to typst --no-cache >/dev/null 2>&1 || { echo "drill: quarto failed"; quarto render report.qmd --to typst --no-cache; exit 1; }
pdf report.pdf quarto

# WeasyPrint, HTML and CSS to PDF
printf '<html><head><style>body{font-family:"Noto Sans";color:#0E7C66}</style></head><body><h1>Sheet</h1><p>Signal</p></body></html>' > page.html
weasyprint page.html weasy.pdf 2>/dev/null
pdf weasy.pdf weasyprint

# MJML, email markup to HTML, from the app's own dependency
node -e "
const mjml = require('/app/node_modules/mjml');
const r = (mjml.default || mjml)('<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>');
Promise.resolve(r).then(o => { if (!/<table/.test(o.html)) { console.error('drill: mjml wrote no table'); process.exit(1); } console.log('drill: mjml ok (' + o.html.length + ' chars)'); });
"
echo "drill: every engine rendered"
