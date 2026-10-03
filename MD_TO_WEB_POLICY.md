# Homebrewery Markdown → Web Reader Policy

This policy defines how Homebrewery-style Markdown is converted into the local digital reader.

## Core rule

The Markdown remains the source of truth. The web reader presents the content semantically; it does not attempt to reproduce Homebrewery's printed page geometry.

## Content structure

- `##` headings become top-level content entries.
- `###` headings become sections inside the current entry.
- `####` headings become subsections.
- `#####` headings become notes, labels, or small callouts.
- Content continues across `\page` markers. `\page` is retained only as source metadata and must not split a web entry.
- Homebrewery wrapper blocks such as `{{wide}}`, `{{clubName}}`, `{{fancyTable}}`, and `::::` are treated as layout hints. Their content is preserved, but the wrapper itself is not rendered as a separate page.

## Images

- Images are inserted at the position where they occur in the Markdown.
- Homebrewery positioning attributes such as `position:absolute`, `top`, `left`, `right`, `width`, and `height` are ignored for the web reader. They were intended for printed-page composition.
- Ignore images whose alt text is `background`, `menu`, or `nameBanner`.
- Ignore image sources whose filenames identify a background or transparent page overlay.
- Keep useful content art such as characters, locations, artifacts, emblems, and illustrations.
- Kept images should render as responsive inline figures with their alt text available as a caption.

## Book-specific configuration

Each book may have a sidecar configuration file, for example `books/euphoria-demo.config.json`. The configuration is the preferred place for exceptions that are specific to one book.

Supported image rule fields:

```json
{
  "match": { "alt": "emblem" },
  "action": "move",
  "location": "entry-top-right",
  "className": "entry-emblem",
  "width": "180px"
}
```

- `match.alt` matches an image alt label; an array may match several labels.
- `match.urlIncludes` may match part of an image URL.
- `action: ignore` removes layout-only artwork from the reader.
- `action: move` removes the image from its source position and reinserts it at the configured semantic location.
- `className` and `width` adjust the presentation without reusing Homebrewery's absolute coordinates.
- `entry-top-right` is a semantic web placement for art that should sit beside an entry heading; the reader controls its responsive float, circular treatment, and spacing.
- Add a reusable renderer rule only when the same kind of exception appears in multiple books. Keep one-off decisions in the individual book configuration.

## Tables and text

- Markdown tables become responsive reader tables.
- Heading levels, paragraphs, bold, italic, links, and unordered lists are preserved.
- Custom CSS is not executed directly. The Maker may extract allowlisted color/font variables into `theme.tokens`; selectors, absolute coordinates, and other Homebrewery layout rules are not carried into the reader.
- Raw HTML is supported only through explicitly recognized safe patterns, such as the demo's video-card block.

## Translated editions

- Store each translated edition as its own canonical book JSON, generated from the same Maker conversion as the source-language edition.
- Translate reader-visible content, headings, table labels/cells, list items, captions, and embed titles; preserve asset URLs, block order, and semantic layout metadata.
- Give the edition its own book ID and set `book.language` and `book.direction` (for example, `fa-IR` and `rtl`). Keep entry and asset IDs aligned with the source edition when practical so both editions can be compared reliably.
- Do not translate proper names; transliterate them into the target script instead (for example, the venue `The Fang` becomes `فنگ` in Persian). Translate ordinary uses of the same word normally (for example, physical fangs remain `نیش`). Apply the distinction consistently to people, places, organizations, items, and named events.
- Do not translate rules values, dice results, URLs, or other identifiers when that would change their meaning. Use a consistent glossary for names and recurring game terms.
- Set the reading direction for the translated script in the package metadata, such as `fa-IR` with `rtl` for Persian. The Reader should use that metadata for the content surface, not rely on per-entry manual direction settings.

## Access and database preparation

The future database representation should store, at minimum:

```text
Book
  - title
  - description
  - theme
  - source_file

Entry
  - book_id
  - title
  - heading_level
  - order_index
  - source_markdown

Block
  - entry_id
  - block_type (section, paragraph, table, image, list, html)
  - heading_level
  - order_index
  - content
  - attributes
```

This keeps the imported source auditable while allowing the web reader to render content without depending on Homebrewery's page layout engine.
