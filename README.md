# TTRPGIR Bookmaker

Open Bookmaker to import Markdown, edit headings, and attach a matching PDF to recover missing artwork. The Reader opens both Bookmaker ZIPs and standalone Book JSON files. See [Book JSON and ZIP format](BOOK_FORMAT.md) for the package layout.

## Update an older book

1. Open its JSON or ZIP in Bookmaker.
2. Select **Reprocess book** in the workflow panel and review the available updates.
3. Select **Apply updates**, then export a new JSON or ZIP. If the book is already current, no changes are needed.

Reprocessing works on the loaded package, so existing text edits, chapter order, image assets, and the chosen palette are retained. The original file is not overwritten.

## GitHub Pages

In the repository’s **Settings → Pages**, select **GitHub Actions** as the publishing source. The [Pages workflow](.github/workflows/pages.yml) builds and tests the site, publishes it on pushes to `main`, and verifies it at the resulting Pages URL. The Reader is the home page and links to `bookmaker.html`.

The workflow publishes the app, its bundled dependencies, and the Euphoria demo files listed in the build script. Bookmaker processes files selected by a visitor in the browser. Existing web image URLs are still loaded from their original hosts.

## Build and test locally

Use Node.js 24 and Chrome. If Chrome is installed in a nonstandard location, set `CHROME_BIN` to its executable path.

```sh
npm install --ignore-scripts --omit=optional --no-save --no-package-lock pdfjs-dist@6.5.438
node scripts/build-pages.mjs
node scripts/smoke-pages.mjs
```

The build writes `dist/`. The smoke test serves it under `/TTRPGIR/` and exercises Markdown import, heading edits, PDF recovery, ZIP export, and Reader import. To run the same check against a deployed site, pass its base URL to `scripts/smoke-pages.mjs`.
