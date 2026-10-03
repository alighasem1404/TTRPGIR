# Canonical Book JSON Format

The Book Maker and Book Reader communicate through one canonical `book.json` package. The full contract is defined in [book-format.schema.json](book-format.schema.json). The Euphoria sample package is at [books/euphoria-demo/book.json](books/euphoria-demo/book.json).

The working local loop is: import Markdown, convert it into this package in memory, export the package as JSON, and load that JSON back into the same reader. The reader renders package blocks rather than the original Markdown.

The local tools are intentionally separated:

- `bookmaker.html` is the private preparation tool. It reads Markdown, applies the builder conversion profile, previews the generated package, and exports JSON.
- `index.html` is the Book Reader. It loads JSON only and contains no Markdown parser or conversion controls.
- `book-format.schema.json` is the shared contract between them.

## Responsibilities

- The Book Maker reads Homebrewery Markdown and produces this package.
- The Book Reader reads this package and never needs to understand Homebrewery syntax.
- `theme` contains the selected visual palette and decorations.
- `book.language` and `book.direction` identify the reader language and text flow, allowing translated packages such as Persian to render right-to-left without changing the original package.
- The Euphoria Persian edition is stored separately at [books/euphoria-demo/book-fa.json](books/euphoria-demo/book-fa.json); it is generated from the same Maker conversion with translated text and unchanged content structure/assets.
- `entries` contain semantic content blocks, not printed-page coordinates.
- `assets` gives images stable IDs so content blocks do not depend on fragile source positions or URLs.
- `conversion` records the standard interpretation used during import. It is useful for reproducibility and re-exporting, but the reader can ignore it after the package is built.
- CSS custom properties from the source header may be mapped into `theme.tokens`. The private Book Maker can choose the extracted source palette or a named preset, then adjust every palette color. The reader applies the exported palette to the page and its shared image decoration.

## Standard conversion behavior

These rules apply to every book unless a future format version changes them:

1. The configured heading level, normally H2, creates an entry.
2. Lower heading levels remain blocks inside that entry.
3. `\page` does not create a web entry. It may be preserved as source metadata.
4. Images are inline by default and appear in source order.
5. Homebrewery absolute positioning is ignored.
6. Backgrounds, page overlays, menus, and decorative banners are ignored by role or source policy.
7. Book-specific layout decisions belong in a builder-side conversion profile or explicit block metadata, not in the global reader.
8. A semantic image placement such as `entry-top-right` may be defined by a builder profile when a book needs an emblem or similar feature art beside an entry heading.

## Versioning rules

- Increase `schemaVersion` when the package shape changes. The current package format is version 1.
- Keep old readers able to reject unsupported major versions cleanly.
- Use stable IDs for books, entries, blocks, and assets.
- Store the source filename and later a source hash so an exported package can be traced back to its Markdown.
- Keep theme tokens allowlisted so the published reader remains safe and consistent.
