// one-pager@1. The field values (title, …, lang) arrive as #let lines before this file.
#import "_shared/brand.typ": *

// ── The section shapes: this block is the same in one-pager@1 and checklist@1 (a spec holds them together) ──
#let filled(value) = value != none and value != ""
#let given(item, key) = filled(item.at(key, default: none))
#let small(body) = text(size: 8.6pt, fill: brand-muted, body)

#let setup(top, bottom, title, footer) = body => {
  set document(title: title)
  set page(paper: "a4", margin: (x: 15mm, top: top, bottom: bottom), footer: footer)
  set text(font: font-body, size: 9.6pt, lang: lang, fill: brand-ink)
  set par(leading: 0.55em)
  show heading: set text(font: font-heading, fill: brand-heading)
  // A word with no place to break would run off the page: past 30 characters it may break anywhere
  show regex("\\S{30}"): it => [#it#sym.zws]
  show heading.where(level: 1): set text(size: 21pt, weight: "bold")
  show heading.where(level: 2): set text(size: 12.5pt, weight: "bold")
  show heading.where(level: 3): set text(size: 10pt, weight: "bold")
  show heading.where(level: 4): set text(size: 10pt, weight: "bold")
  show heading: set block(above: 0pt, below: 2.6mm)
  body
}

// A section's title at `level`, its items one level down; with no title the items take the level, so none is skipped
#let section-head(s, level) = {
  if given(s, "title") { heading(level: level, s.title) }
  if given(s, "intro") {
    text(fill: brand-muted, s.intro)
    v(1.5mm)
  }
}
#let sub-level(s, level) = if given(s, "title") { level + 1 } else { level }
// An item's title reads the same at any level
#let item-title(level, title) = {
  show heading: set text(size: 10pt)
  heading(level: level, title)
}

#let number(n) = box(width: 6mm, height: 6mm, radius: 3mm, fill: brand-primary)[
  #set align(center + horizon)
  #text(fill: brand-on-primary, weight: "bold", size: 9pt)[#n]
]

// The box in one column and the text in the next, so a long item hangs beside its box
#let check(item) = grid(
  columns: (5.5mm, 1fr),
  box(width: 3.6mm, height: 3.6mm, stroke: 0.8pt + brand-primary, radius: 0.8pt),
  if given(item, "title") [*#item.title* #item.body] else [#item.body],
)

#let text-section(s, level) = {
  let body = [
    #if given(s, "title") { if s.style == "box" { item-title(level, s.title) } else { heading(level: level, s.title) } }
    #s.body
  ]
  if s.style == "box" {
    block(width: 100%, stroke: 0.6pt + brand-primary.lighten(55%), inset: 3.5mm, radius: 1.5mm, body)
  } else if s.style == "quiet" {
    align(center, text(fill: brand-muted, body))
  } else { body }
}

#let points-section(s, level) = {
  section-head(s, level)
  let sub = sub-level(s, level)
  grid(
    columns: (1fr,) * s.columns,
    column-gutter: 5mm,
    row-gutter: 3mm,
    ..s.items.map(i => [
      #item-title(sub, i.title)
      #i.body
    ]),
  )
}

#let card-text(item, level) = [
  #item-title(level, item.title)
  #if given(item, "body") [#item.body]
  #if given(item, "lines") [#block(above: 1mm, small(item.lines.join("\n")))]
]

// A card's picture sits at its left edge; a card without one is its text alone, and nothing is drawn in its place
#let card(item, level) = if given(item, "image") {
  grid.cell(inset: 0pt, grid(
    columns: (36%, 1fr),
    align: (left, left + horizon),
    image(item.image.path, width: 100%, alt: item.image.alt),
    pad(x: 2.5mm, y: 1.5mm, card-text(item, level)),
  ))
} else { card-text(item, level) }

#let cards-section(s, level) = {
  section-head(s, level)
  let sub = sub-level(s, level)
  let closing = if given(s, "closing") {
    (grid.cell(fill: brand-primary, text(fill: brand-on-primary, s.closing)),)
  } else { () }
  // A grid fills its cells, so the cards of a row are one height
  grid(columns: (1fr,) * s.columns, gutter: 2.5mm, fill: brand-tint, inset: 3.2mm, ..s.items.map(i => card(i, sub)), ..closing)
}

#let steps-section(s, level) = {
  section-head(s, level)
  let sub = sub-level(s, level)
  if s.columns == 1 {
    stack(spacing: 2.6mm, ..s.items.enumerate().map(((n, i)) => grid(
      columns: (8mm, 1fr),
      number(n + 1),
      [*#i.title* \ #i.body],
    )))
  } else {
    grid(
      columns: (1fr,) * s.columns,
      column-gutter: 4mm,
      row-gutter: 3mm,
      ..s.items.enumerate().map(((n, i)) => [
        #number(n + 1)
        #v(1mm)
        #item-title(sub, i.title)
        #i.body
      ]),
    )
  }
}

#let facts-section(s, level) = block(width: 100%, fill: brand-tint, inset: 3.2mm, radius: 1.5mm)[
  #if given(s, "title") { heading(level: level, s.title) }
  #stack(spacing: 1.9mm, ..s.items.map(i => grid(
    columns: (1fr, auto),
    column-gutter: 3mm,
    text(fill: brand-muted, i.label),
    strong(i.value),
  )))
  #if given(s, "note") [
    #v(1.5mm)
    #small(s.note)
  ]
]

#let checks-section(s, level) = {
  let body = [
    #section-head(s, level)
    #grid(columns: (1fr,) * s.columns, column-gutter: 6mm, row-gutter: 2.6mm, ..s.items.map(check))
    #if given(s, "note") [
      #v(1.5mm)
      #small(s.note)
    ]
  ]
  if s.boxed { block(width: 100%, fill: brand-tint, inset: 4mm, radius: 1.5mm, body) } else { body }
}

#let leaf-section(s, level) = {
  if s.kind == "text" { text-section(s, level) }
  else if s.kind == "points" { points-section(s, level) }
  else if s.kind == "cards" { cards-section(s, level) }
  else if s.kind == "steps" { steps-section(s, level) }
  else if s.kind == "facts" { facts-section(s, level) }
  else if s.kind == "checks" { checks-section(s, level) }
}

#let section(s) = if s.kind == "row" {
  section-head(s, 2)
  let level = sub-level(s, 2)
  if given(s, "title") { v(1mm) }
  grid(
    columns: (1fr, 1fr),
    column-gutter: 7mm,
    stack(spacing: 5mm, ..s.left.map(x => leaf-section(x, level))),
    stack(spacing: 5mm, ..s.right.map(x => leaf-section(x, level))),
  )
} else { leaf-section(s, 2) }

// The contact band closes the page: brand-on-primary on the band, brand-on-accent on the button
#let contact-band(c) = block(width: 100%, fill: brand-primary, inset: (x: 6mm, y: 4.5mm), radius: 1.5mm, breakable: false)[
  #set text(fill: brand-on-primary)
  #grid(
    columns: (1fr, auto),
    align: (left + horizon, right + horizon),
    column-gutter: 6mm,
    [
      #text(font: font-heading, weight: "bold", size: 12.5pt)[#c.title]
      #if given(c, "line") [\ #text(size: 9.4pt)[#c.line]]
    ],
    if given(c, "cta_url") {
      link(c.cta_url, box(fill: brand-accent, inset: (x: 5mm, y: 2.6mm), radius: 1.2mm, text(fill: brand-on-accent, weight: "bold", c.cta_label)))
    },
  )
]

// The sections with the page's free space shared between them, then the band at the foot
#let body-sections() = {
  for s in sections {
    section(s)
    v(1.2fr)
  }
  if contact != none { contact-band(contact) }
}

// A stacked logo fits a head; a brand without one has its primary logo
#let head-logo(mode, height) = {
  let stacked = brand-logo(variant: "stacked", mode: mode, height: height, alt: company.name)
  if stacked != none { stacked } else { brand-logo(mode: mode, height: height, alt: company.name) }
}
// ── End of the section shapes ──

#show: setup(13mm, 17mm, title, context [
  #set text(size: 7.5pt, fill: brand-muted)
  #brand-legal.at("footer", default: company.name) #h(1fr) #web
])

#block(width: 100%, fill: brand-primary, inset: (x: 7mm, y: 5.5mm), radius: 1.5mm)[
  #set text(fill: brand-on-primary)
  #show heading: set text(fill: brand-on-primary, size: 18pt)
  #grid(
    columns: (1fr, auto),
    align: (left + horizon, right + horizon),
    column-gutter: 8mm,
    [
      #if filled(tagline) { block(below: 2.5mm, tagline) }
      = #title
    ],
    head-logo(brand-primary-logo-mode, 18mm),
  )
]
#v(1fr)
#if filled(intro) [
  #text(size: 11pt, intro)
  #v(1.2fr)
]

#body-sections()

// A one-pager is one page: content that does not fit is refused, it does not spill onto a second
#context if counter(page).final().first() > 1 {
  panic("one-pager@1: the content does not fit on one page")
}
