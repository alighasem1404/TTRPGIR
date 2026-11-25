# Canonical Book JSON Format

The Book Maker and Book Reader communicate through one canonical `book.json` package. The full contract is defined in [book-format.schema.json](book-format.schema.json). The Euphoria sample package is at [books/euphoria-demo/book.json](books/euphoria-demo/book.json).

Import Markdown in Book Maker and open the exported book in the Reader. The Reader renders package blocks from the JSON, whether it comes from a standalone file or a ZIP.

The local tools are intentionally separated:

- `bookmaker.html` is the preparation tool. It reads Markdown, applies the builder conversion profile, previews the generated package, and exports JSON or a book ZIP.
- `index.html` is the Book Reader. It opens standalone JSON and book ZIPs.
- `book-format.schema.json` is the shared contract between them.

## Book ZIP

Book Maker exports a ZIP once a replacement image has been applied. The archive contains `book.json` at the top level and the recovered WebP files in `images/`. Each recovered asset points to its file with an archive-relative path such as `images/moonlit-market.webp`. Original asset URLs still apply to figures without replacements.

Open the ZIP directly in the Reader to use its bundled images offline. The Reader also accepts older ZIPs with bundled PNG images. Any original image URLs that point to the web still need a network connection. You can extract the ZIP to reuse the image files separately. The archive supports Book JSON v1, v2, and v3.

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
2. H1 headings are non-clickable part labels in the contents list. They remain heading blocks and introduce the following H2 entries without creating extra entries. H3–H6 remain blocks inside the entry. Headings within a monster stat block never create entries or contents links.
3. `\page` does not create a web entry. It may be preserved as source metadata.
4. Images are inline by default and appear in source order.
5. Homebrewery absolute positioning is ignored.
6. Backgrounds, page overlays, menus, and decorative banners are ignored on text pages by role or source policy. Artwork on image-only source pages is preserved as an image block with role `full-page` and displayed without the usual illustration height limit, unless an explicit image ignore override applies.
7. Book-specific layout decisions belong in a builder-side conversion profile or explicit block metadata, not in the global reader.
8. A semantic image placement such as `entry-top-right` may be defined by a builder profile when a book needs an emblem or similar feature art beside an entry heading.

9. Explicit HTML line breaks (`<br>`, `<br/>`, `<br />`) become newline characters (`\n`) in text fields. Both the Maker and Reader display these as line breaks.

## Link blocks

A standalone Markdown link such as `[Read the guide](https://example.com/guide)` is stored as a dedicated content block:

```json
{ "type": "link", "text": "Read the guide", "url": "https://example.com/guide" }
```

The label and destination can be edited independently in the Maker's preview editor. Link blocks accept absolute HTTP and HTTPS URLs and open in a new tab. The Reader styles the label as clickable text. Links embedded within paragraphs, lists, or tables remain inline Markdown. Link blocks may also belong to a stat-block group.

For an older package, **Reprocess book** converts unstyled paragraphs containing only a valid standalone Markdown link into link blocks, retaining their position and any stat-group membership. It does not split mixed-text paragraphs or change their inline links.

## Monster stat blocks

A balanced Homebrewery `{{monster ... }}` wrapper defines one stat block, including nested directives, tables, images, and headings. The outer wrapper is detected before splitting the source into H2 entries. Each contained content block is stored normally with an additional `statBlock` string identifying its group. For example:

```json
[
  { "type": "heading", "level": 2, "text": "Creature name", "statBlock": "chapter-1-stat-1" },
  { "type": "paragraph", "text": "**AC**: 16\n**HP**: 104", "statBlock": "chapter-1-stat-1" }
]
```

The Maker and Reader render consecutive blocks sharing that ID in one styled panel. Monster headings do not become book navigation items, and nested ability-score tables can display together. Block membership is retained during preview edits and ZIP/JSON export. The original Markdown is needed to identify wrappers omitted from older v1 exports; use **Restore from Markdown → Stat blocks** to recover the grouping without replacing edited content.

## Manual reprocessing

Book Maker can run the latest package-level conversion rules on a loaded JSON or ZIP using **Reprocess book**. The dialog previews each rule and the entry count before applying changes. The initial rules normalize legacy HTML break tags in text fields and relocate H1 part headings (and their introductory content) to the next entry, merging redundant part-only entries without discarding their blocks. Existing line breaks normalized automatically on opening are reported as well.

New package upgrades should be registered in `BOOK_REPROCESS_RULES` in `book-reprocessing.js`. Each rule operates on a staged package, reports whether it made changes, and must be safe to run repeatedly. Preserve existing content, the order of blocks, surviving entry IDs, asset references, and Maker-only editing metadata. Reprocessing does not require a schema-version change just to apply newer conversion rules.

Only data still present in the package can be reprocessed. Content discarded by an older Markdown import cannot be reconstructed without the original source.

## Restoring missing source images

**Restore from Markdown** compares an attached source with the open package using the current import rules, including image-only page artwork. The source is a reference only; the existing package remains the authoritative edited book. Matching considers image occurrences, original URLs, entry IDs/titles, and nearby content. Possible replacements, reused images, and uncertain positions are flagged for review instead of selected automatically.

Applying the selection inserts only new image blocks at the chosen boundaries. Existing block objects, entry metadata/order, theme, source metadata, and assets remain intact. An existing matching asset is reused when possible; otherwise a unique asset ID is allocated. The reference Markdown is not embedded in the exported package, and no schema change is required. This recovers image references, not unavailable image bytes; bundled and recovered images already in the book are preserved.

## Recovering stat-block grouping from older exports

The **Stat blocks** restore mode detects the original monster wrappers, matches legacy entry IDs and nearby block boundaries, and proposes ranges of existing blocks to assign a statBlock ID. It does not copy the original stat values over edited ones. Ambiguous boundaries require manual review. If a wrapper spans legacy entries, its internal entry boundaries are merged so the card remains contiguous. A separately listed legacy monster entry can optionally be folded into its predecessor; the preview identifies these merges and their entry count impact. Every existing block remains in its original order, with surviving entry metadata and assets preserved. Legacy double-colon stat rows are displayed with line breaks without rewriting stored text. The resulting package uses schema version 2 or later.

## Versioning rules

- Increase `schemaVersion` when the package shape changes. Version 2 supports the optional statBlock group identifier; version 3 adds the link block type. Packages without newer block types or grouping may keep their earlier version; all three versions are readable.
- Keep old readers able to reject unsupported major versions cleanly.
- Use stable IDs for books, entries, blocks, and assets.
- Store the source filename and later a source hash so an exported package can be traced back to its Markdown.
- Keep theme tokens allowlisted so the published reader remains safe and consistent.
