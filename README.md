# TTRPGIR Bookmaker

Open Bookmaker to import Markdown, edit headings, and attach a matching PDF to recover missing artwork. The Reader opens both Bookmaker ZIPs and standalone Book JSON files. See [Book JSON and ZIP format](BOOK_FORMAT.md) for the package layout.

## Update an older book

1. Open its JSON or ZIP in Bookmaker.
2. Select **Reprocess book** in the workflow panel and review the available updates.
3. Select **Apply updates**, then export a new JSON or ZIP. If the book is already current, no changes are needed.

Reprocessing works on the loaded package, so existing text edits, chapter order, image assets, and the chosen palette are retained. The original file is not overwritten.

## Restore missing images and stat blocks from the original Markdown

1. Open your existing JSON or ZIP in Bookmaker.
2. Choose **Restore from Markdown** and select its original Markdown file (or use the current loaded Markdown).
3. Choose **Missing images** and review image previews, the source page, and suggested entry and insertion position. Nothing is selected automatically. **Select suggested** selects only confidently placed images without possible duplicate or replacement matches.
4. Select any other images you want and choose their destinations. Apply **Restore selected images**, then export the updated package.

This adds selected image blocks and any required assets without reimporting the book or changing existing text, headings, entry order, captions, palette, or bundled and recovered images. An image's original URL may still need repair through the existing image recovery workflow if its host is unavailable.

For an older book whose monster wrappers were lost, choose **Stat blocks** instead. Review the suggested first and last included blocks, then select the groups to recover. The tool can merge redundant legacy monster entries into the preceding entry (and merge internal entry boundaries when one stat block spans several entries); all existing blocks remain in their original order and retain their edited content. You can leave a legacy entry separate by clearing its optional merge checkbox. Apply **Recover selected stat blocks** and export the result. Image and stat-block updates are applied separately.

## Link blocks

In **Edit preview**, choose **Add below** and set **Format** to **Link** to enter display text and an HTTP or HTTPS destination. Existing paragraph blocks can be converted to links, and existing link blocks can be edited directly. Standalone Markdown links import automatically; **Reprocess book** upgrades standalone links in older packages.

## GitHub Pages

In the repository’s **Settings → Pages**, select **GitHub Actions** as the publishing source. The [Pages workflow](.github/workflows/pages.yml) builds and tests the site, publishes it on pushes to `main`, and verifies it at the resulting Pages URL. The Reader is the home page and links to `bookmaker.html`.

The workflow publishes the app, its bundled dependencies, and the Euphoria demo files listed in the build script. Bookmaker processes files selected by a visitor in the browser. Existing web image URLs are still loaded from their original hosts.

The main English Euphoria demo includes a **Stat block example** entry showing Abelard's complete monster stat block in Bookmaker and the Reader.

The version beside **CONTENT LAB** identifies the running app, independently of the book schema version. The base version is defined in `app-version.js`. Local development shows `v0.1.0-local`; GitHub Pages builds append the workflow run number (and retry attempt, when applicable), such as `v0.1.0+123`. Hover over the badge on a published build to see its commit identifier.

## Build and test locally

Use Node.js 24 and Chrome. If Chrome is installed in a nonstandard location, set `CHROME_BIN` to its executable path.

```sh
npm install --ignore-scripts --omit=optional --no-save --no-package-lock pdfjs-dist@6.5.438
node scripts/build-pages.mjs
node scripts/smoke-pages.mjs
```

The build writes `dist/`. The smoke test serves it under `/TTRPGIR/` and exercises Markdown import, heading edits, PDF recovery, ZIP export, and Reader import. To run the same check against a deployed site, pass its base URL to `scripts/smoke-pages.mjs`.
