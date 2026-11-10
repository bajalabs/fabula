#!/usr/bin/env python3
"""A brand's reference .docx or .pptx, from Pandoc's default one.

    office-theme.py <Pandoc's default reference> <out> <theme.json>

theme.json: {"colors": {"accent1": "0E7C66", "hlink": "2D6A8E", ...}, "fonts": {"major": "Alfa Slab One", "minor": "Noto Sans"}}

Word's heading and body styles and PowerPoint's masters take their fonts and colours from the theme part, so the brand
rewrites every */theme/theme<n>.xml: the named scheme colours (each becomes an srgbClr) and the Latin typefaces of
the major (headings) and minor (body) fonts. Every other entry is copied as it was, in order, with its own
compression, so [Content_Types].xml stays first. Standard library only; it prints nothing on success.
"""
import json
import re
import sys
import zipfile
from xml.sax.saxutils import quoteattr

SLOTS = {"dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"}
HEX = re.compile(r"^[0-9A-F]{6}$")
THEME = re.compile(r"(^|/)theme/theme\d+\.xml$")


def rewrite(xml: str, colors: dict, fonts: dict) -> str:
    for slot, val in colors.items():
        xml = re.sub(rf"(<a:{slot}>).*?(</a:{slot}>)", lambda m: f'{m.group(1)}<a:srgbClr val="{val}"/>{m.group(2)}', xml, count=1, flags=re.S)
    for kind in ("major", "minor"):
        family = fonts.get(kind)
        if family:
            # always double-quoted, " as &quot; (Python 3.11 in the image: no nested quotes in f-strings);
            # the panose number describes the old face, so it goes with it
            typeface = quoteattr(family, {'"': "&quot;"})
            xml = re.sub(rf"(<a:{kind}Font>\s*<a:latin )[^>]*?(/?>)", lambda m: f"{m.group(1)}typeface={typeface}{m.group(2)}", xml, count=1, flags=re.S)
    return xml


def main(argv: list) -> int:
    if len(argv) != 4:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    src, out, spec = argv[1:4]
    theme = json.load(open(spec, encoding="utf-8"))
    colors = {k: str(v).lstrip("#").upper() for k, v in (theme.get("colors") or {}).items()}
    for slot, val in colors.items():
        if slot not in SLOTS or not HEX.match(val):
            print(f"office-theme: bad colour {slot}={val}", file=sys.stderr)
            return 2
    fonts = {k: v for k, v in (theme.get("fonts") or {}).items() if k in ("major", "minor") and isinstance(v, str) and v.strip()}
    themes = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if THEME.search(item.filename):
                data = rewrite(data.decode("utf-8"), colors, fonts).encode("utf-8")
                themes += 1
            zout.writestr(item, data)
    if themes == 0:
        print("office-theme: no theme part in the reference document", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
