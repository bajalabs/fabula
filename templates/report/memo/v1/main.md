---
lang: en
---

```{=typst}
// The brand's names (font-body, brand-primary, …), as a Typst template imports them
#import "/_shared/brand.typ": *
#set text(font: font-body)
#block(below: 1.2em)[
  #text(font: font-heading, size: 20pt, weight: "bold", fill: brand-primary, title) \
  #text(fill: brand-dim, author + " · " + date)
]
```

## Summary

`#summary`{=typst}

## Highlights

```{=typst}
#list(..highlights)
```

## Next steps

The rest of this memo is plain Markdown: **bold**, *italic*, lists and tables
work as usual, and Pandoc writes them through Typst into the PDF.

| Step | Owner | When |
|------|-------|------|
| Review the figures | Finance | This week |
| Share the memo | Office | Friday |
