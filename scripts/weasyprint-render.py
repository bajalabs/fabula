#!/usr/bin/env python3
"""HTML to PDF with WeasyPrint, reading nothing outside the render's folder.

    weasyprint-render.py <input.html> <output.pdf> [--pdf-tags] [--pdf-variant pdf/ua-1]

Every resource the page names (a stylesheet, an image, a font, an attachment) goes through a URL fetcher that
answers data: URLs and files inside the folder of <input.html>, and nothing else: no http or https, no file
elsewhere, no symbolic link that leads out. A refused resource is left out of the page, and WeasyPrint says so on
stderr as a warning. Presentational hints are on and the media type is print, as WeasyPrint's own command line is
called otherwise. Needs WeasyPrint 70 (weasyprint.urls.URLFetcher); allowed() runs without it.
"""
import argparse
import logging
import os
import sys
from urllib.parse import unquote, urlsplit


def allowed(url, root):
    """True when `url` is a data: URL or a file under `root` (its real path, after links)."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme == "data":
        return True
    if scheme != "file" or parts.netloc not in ("", "localhost"):
        return False
    real_root = os.path.realpath(root)
    path = os.path.realpath(unquote(parts.path))
    return path.startswith(real_root + os.sep)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--pdf-tags", action="store_true")
    parser.add_argument("--pdf-variant")
    args = parser.parse_args(argv)

    import weasyprint
    from weasyprint.urls import URLFetcher

    root = os.path.dirname(os.path.realpath(args.input))

    class ConfinedFetcher(URLFetcher):
        def fetch(self, url, headers=None):
            if not allowed(url, root):
                scheme = urlsplit(url).scheme.lower() or "a relative"
                raise ValueError(f"{scheme} URL outside the render is not fetched")
            return super().fetch(url, headers)

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    for name in ("weasyprint", "weasyprint.progress"):
        logger = logging.getLogger(name)
        logger.handlers = [handler]
        logger.setLevel(logging.WARNING)
        logger.propagate = False

    options = {"presentational_hints": True}
    if args.pdf_tags:
        options["pdf_tags"] = True
    if args.pdf_variant:
        options["pdf_variant"] = args.pdf_variant
    html = weasyprint.HTML(filename=args.input, base_url=root, url_fetcher=ConfinedFetcher(), media_type="print")
    html.write_pdf(args.output, **options)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:  # the message only: a traceback would print the server's paths
        print(f"ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
