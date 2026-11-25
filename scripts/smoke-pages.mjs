import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const mount = "/TTRPGIR/";
const arg = process.argv[2];
let server;
let base;
if (arg === "--file") base = pathToFileURL(dist);
else if (arg) base = new URL(arg.replace(/\/?$/, "/"));
else {
  server = createServer(serveSite);
  await new Promise((ready, reject) => server.once("error", reject).listen(0, "127.0.0.1", ready));
  base = new URL(`http://127.0.0.1:${server.address().port}${mount}`);
}

try {
  for (const width of [1280, 440]) {
    await smoke(width);
    console.log(`Bookmaker and Reader passed at ${width}px on ${base.href}`);
  }
} finally {
  server?.close();
}

async function serveSite(request, response) {
  if (request.method !== "GET") return response.writeHead(405).end();
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (!path.startsWith(mount)) return response.writeHead(404).end();
    const file = resolve(dist, path.slice(mount.length) || "index.html");
    if (!file.startsWith(resolve(dist) + sep)) return response.writeHead(404).end();
    const types = {
      ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
      ".txt": "text/plain", ".json": "application/json", ".wasm": "application/wasm"
    };
    response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}

async function smoke(width) {
  const browser = startChrome();
  try {
    const maker = await browser.page("bookmaker.html", width);
    await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Maker demo");
    await smokePartsAndBreaks(browser, width);
    const pdfBase = new URL(await maker.evaluate(() => {
      const script = document.querySelector("script[data-pdf-engine]");
      return new URL(script.dataset.pdfEngine, script.src).href;
    }));
    assert.ok(pdfBase.href.startsWith(new URL("vendor/pdfjs/", base).href), "PDF.js is bundled under the site path");
    if (base.protocol !== "file:") {
      for (const module of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
        const response = await fetch(new URL("legacy/build/" + module, pdfBase));
        assert.ok(response.ok, `Missing ${module}`);
        assert.match(response.headers.get("content-type") || "", /javascript|ecmascript/i);
        await response.body.cancel();
      }
    }

    await maker.upload("mdInput", "local-source-smoke.md",
      "## At the Harbor\r\n![Books Image](missing-smoke-lantern.png) {position:absolute,bottom:-4%,width:100%,height:}\r\nFigure 1 Harbor Lantern\r\n### Sample\r\n" +
      "\\page\r\n![Books Image](missing-smoke-lantern.png){width:100%}\r\nFigure 1 Harbor Lantern\r\n" +
      "# Interlude\n### Backstory\n### Backstory ###\n#### Backstory\n##### Notes\n###### Details");
    await maker.until(() => state.source.includes("# At the Harbor"), "Local Markdown import");
    const headings = await maker.evaluate(() => {
      document.getElementById("openHeadings").click();
      const title = document.querySelector('input[aria-label="Title for H2 At the Harbor"]');
      title.value = "Lantern at the Harbor";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      const groups = [...document.querySelectorAll('input[aria-label="Title for H3 Backstory"]')];
      const backstory = groups[0];
      const count = backstory.parentElement.querySelector(".heading-count").textContent;
      const columns = [...document.querySelectorAll(".heading-grid:not(.heading-grid-extra) > .heading-column")];
      const lefts = columns.map((column) => column.getBoundingClientRect().left);
      const level = backstory.parentElement.querySelector("select");
      backstory.value = "Origins";
      backstory.dispatchEvent(new Event("input", { bubbles: true }));
      level.value = "4";
      level.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("previewHeadings").click();
      const staged = state.source.includes("### Backstory");
      document.getElementById("applyHeadings").click();
      return {
        groups: groups.length, count, staged, lefts,
        extras: [...document.querySelectorAll(".heading-grid-extra h3")].map((h) => h.textContent),
        edits: state.source.split("\n").slice(-5)
      };
    });
    assert.equal(headings.groups, 1);
    assert.equal(headings.count, "2");
    assert.equal(headings.staged, true);
    assert.equal(headings.lefts.length, 4);
    assert.ok(headings.lefts.every((left, index, all) => index === 0 || left > all[index - 1]));
    assert.deepEqual(headings.extras, ["H5", "H6"]);
    assert.deepEqual(headings.edits, ["#### Origins", "#### Origins ###", "#### Backstory", "##### Notes", "###### Details"]);
    await maker.upload("pdfInput", "local-source-smoke.pdf", [...fixturePdf()]);
    await maker.until(() => document.getElementById("imageRecovery").open &&
      !document.getElementById("recoverySetup").hidden, "Book-wide filename choice");
    await maker.evaluate(() => document.getElementById("recoverySetup").requestSubmit());
    await maker.until(() => !document.getElementById("applyRecovery").disabled, "Strong match prefilled");
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "lantern-at-the-harbor.webp");
    await maker.until(() => Boolean(document.querySelector("#pdfImages button")), "Embedded image download ready");
    const extraction = await inspectPdfDownload(maker, false);
    assert.deepEqual(extraction, { filename: "page-1-image-1.webp", type: "image/webp", width: 16, height: 16,
      alpha: [0, 128, 255], lossy: true });
    await maker.evaluate(() => {
      document.getElementById("recoveryPageNumber").value = 2;
      document.getElementById("jumpRecoveryPage").requestSubmit();
    });
    await maker.until(() => document.getElementById("recoveryPosition").textContent.includes("Markdown page 2"), "Jump to Markdown page");
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "lantern-at-the-harbor-2.webp");
    await maker.evaluate(() => document.getElementById("previousRecovery").click());
    await maker.evaluate(() => document.getElementById("nextRecoveryPage").click());
    assert.match(await maker.evaluate(() => document.getElementById("recoveryPosition").textContent), /Markdown page 2/);
    await maker.evaluate(() => document.getElementById("previousRecovery").click());
    await maker.until(() => !document.getElementById("pdfImageHighlight").hidden, "PDF pane and highlighted match");
    await maker.evaluate(() => document.getElementById("pdfNext").click());
    await maker.until(() => document.getElementById("pdfPageNumber").value === "2" &&
      !document.getElementById("pdfPageBody").hidden, "Next PDF page");
    const crop = await inspectPdfDownload(maker, true);
    assert.equal(crop.filename, "page-2-crop.webp");
    assert.equal(crop.type, "image/webp");
    assert.ok(Math.abs(crop.width - 135) <= 2 && Math.abs(crop.height - 234) <= 2, "Crop keeps selected raster dimensions");
    assert.equal(crop.alpha[0], 0, "Blank PDF areas stay transparent in crops");
    await maker.evaluate(() => {
      document.getElementById("pdfPageNumber").value = 1;
      document.getElementById("jumpPdfPage").requestSubmit();
    });
    await maker.until(() => document.getElementById("pdfPageNumber").value === "1" &&
      !document.getElementById("pdfPageBody").hidden, "Jump to PDF page");
    const canvasHeight = await maker.evaluate(() => document.getElementById("pdfPageCanvas").getBoundingClientRect().height);
    assert.ok(canvasHeight > 0 && canvasHeight <= (width === 440 ? 291 : 541), "PDF page fits at review scale");

    await maker.upload("pdfInput", "local-source-smoke.pdf", [...fixturePdf()]);
    await maker.until(() => document.getElementById("imageRecovery").open && !document.getElementById("recoverySetup").hidden, "Replacement PDF asks for naming");
    await maker.evaluate(() => {
      document.querySelector('[name="recoveryNaming"][value="h3"]').checked = true;
      document.getElementById("recoverySetup").requestSubmit();
    });
    await maker.until(() => !document.getElementById("applyRecovery").disabled, "Nearest H3 match ready");
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "sample.webp");
    await maker.evaluate(() => {
      document.getElementById("recoveryCaption").value = "Harbor Lantern";
      document.getElementById("recoveryForm").requestSubmit();
    });
    await maker.until(() => document.getElementById("recoveryPosition").textContent.includes("Image 2 of 2") &&
      document.getElementById("recoveryFileName").value === "sample-2.webp" &&
      !document.getElementById("applyRecovery").disabled, "Next image and unique filename");
    await maker.evaluate(() => document.getElementById("viewRecoveredPreview").click());
    await maker.until(() => {
      const recovered = document.querySelector("#pageViewport [data-recovered-block]");
      return !document.getElementById("imageRecovery").open && recovered?.naturalWidth === 16 &&
        recovered.alt === "Harbor Lantern" && document.activeElement === recovered &&
        !document.getElementById("pageViewport").textContent.includes("position:absolute");
    }, "Preview renders the recovered Homebrewery image and omits positioning markup");
    await maker.evaluate(() => document.getElementById("openImageRecovery").click());
    await maker.until(() => !document.getElementById("applyRecovery").disabled &&
      document.getElementById("recoveryFileName").value === "sample-2.webp", "Naming persists on reopen");
    await maker.evaluate(() => {
      document.getElementById("recoveryForm").requestSubmit();
      document.getElementById("imageRecovery").close();
      document.getElementById("exportButton").click();
    });
    await maker.until(() => !document.getElementById("downloadBookZip").disabled, "ZIP ready");
    assert.equal(await maker.evaluate(() => zipExport.fileName), "local-source-smoke.zip");
    const zip = await maker.evaluate(async () => {
      const createURL = URL.createObjectURL;
      let blob;
      URL.createObjectURL = (value) => { blob = value; return createURL.call(URL, value); };
      HTMLAnchorElement.prototype.click = () => {};
      document.getElementById("downloadBookZip").click();
      return [...new Uint8Array(await blob.arrayBuffer())];
    });

    const reader = await browser.page("index.html", width);
    await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader demo");
    await reader.upload("jsonInput", "lantern-smoke.zip", zip);
    await reader.until(() => {
      const images = [...document.querySelectorAll(".page-content img[src^='blob:']")];
      return images.length === 2 && images.every((image) => image.naturalWidth === 16) && images[0].alt === "Harbor Lantern" &&
        document.getElementById("currentLabel").textContent === "Lantern at the Harbor";
    }, "Reader renders both recovered images");
    const legacy = await reader.evaluate(async () => {
      const book = structuredClone(readerState.bookPackage);
      const zip = new JSZip();
      for (const asset of book.assets.filter(({ src }) => src.endsWith(".webp"))) {
        asset.src = asset.src.replace(/\.webp$/, ".png");
        const image = document.createElement("canvas");
        image.width = image.height = 12;
        const png = await new Promise((resolve) => image.toBlob(resolve, "image/png"));
        zip.file(asset.src, await png.arrayBuffer());
      }
      zip.file("book.json", JSON.stringify(book));
      return [...await zip.generateAsync({ type: "uint8array" })];
    });
    await reader.upload("jsonInput", "older-png-book.zip", legacy);
    await reader.until(() => {
      const images = [...document.querySelectorAll(".page-content img[src^='blob:']")];
      return images.length === 2 && images.every((image) => image.naturalWidth === 12);
    }, "Reader still renders original ZIPs containing PNGs");
    await smokeReopenBook(browser, width, zip, legacy);
    for (const request of maker.requests) {
      assert.ok(["GET", "HEAD"].includes(request.method) && !request.hasPostData, "No file upload request");
      assert.doesNotMatch(request.url, /local-source-smoke/);
      if (/pdf(?:\.worker|\.renderer)?\.min\.mjs(?:\?|$)/.test(request.url)) {
        assert.ok(request.url.startsWith(pdfBase.href), "PDF.js requests stay under the project site");
      }
    }
    await smokeBookEditing(browser, width);
    await smokeBulkEditing(browser, width);
    await smokeTableAndListEditing(browser, width);
    await smokeFindAndReplace(browser, width);
    await smokeOrganizationAndCaptions(browser, width);
    await smokeHeadingGroupOrdering(browser, width);
    await smokeImageReload(browser, width);
  } finally {
    browser.close();
  }
}

async function smokeReopenBook(browser, width, originalZip, legacyZip) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Maker ready to reopen exports");
  const standalone = await maker.evaluate(() => JSON.stringify(state.bookPackage));
  assert.equal(await maker.evaluate(() => document.querySelector('label[for="jsonInput"]').getBoundingClientRect().width > 0), true);
  await maker.upload("jsonInput", "saved-book.zip", originalZip);
  await maker.until(() => {
    const images = [...document.querySelectorAll("#pageViewport img[src^='blob:']")];
    return state.bundledImages.size === 2 && images.length === 2 && images.every((image) => image.naturalWidth === 16);
  }, "Bookmaker reopens ZIP images without the original Markdown or PDF");
  assert.equal(await maker.evaluate(() => document.getElementById("openHeadings").disabled), false);
  assert.equal(await maker.evaluate(() => document.getElementById("exportButton").textContent), "Export Book ZIP");
  assert.equal(await maker.evaluate(() => document.getElementById("attachPdf").disabled), false);
  await maker.upload("pdfInput", "reopened-zip.pdf", [...fixturePdf()]);
  await maker.until(() => document.getElementById("imageRecovery").open && !document.getElementById("recoverySetup").hidden,
    "PDF attachment opens after a ZIP import");
  await maker.evaluate(() => document.getElementById("recoverySetup").requestSubmit());
  await maker.until(() => document.getElementById("recoveryStatus").textContent.includes("2 working") &&
    document.getElementById("recoveryReview").hidden, "Bundled ZIP images are recognized as working during PDF recovery");
  await maker.evaluate(() => document.getElementById("imageRecovery").close());
  const currentBook = await maker.evaluate(() => JSON.stringify(state.bookPackage));
  for (const [name, data] of [["invalid.json", "{"], ["invalid.zip", [0, 1, 2]],
    ["invalid-content.json", JSON.stringify({ format: "ttrpg-book", schemaVersion: 1, book: { id: "bad", title: "Bad" },
      assets: [], entries: [{ id: "one", title: "One", blocks: [{ type: "table", columns: [], rows: ["invalid"] }] }] })]]) {
    await maker.evaluate(() => { document.getElementById("notice").textContent = ""; });
    await maker.upload("jsonInput", name, data);
    await maker.until(() => document.getElementById("notice").textContent.startsWith("Could not open "), "Invalid book is rejected");
    assert.ok((await maker.evaluate(() => document.getElementById("notice").textContent)).includes(name));
    assert.equal(await maker.evaluate(() => JSON.stringify(state.bookPackage)), currentBook);
    assert.equal(await maker.evaluate(() => state.bundledImages.size), 2);
  }
  await maker.evaluate(() => document.getElementById("exportButton").click());
  await maker.until(() => !document.getElementById("downloadBookZip").disabled, "Unedited ZIP ready to export again");
  const unchanged = await maker.evaluate(async () => {
    const { bookPackage, images } = await window.bookArchive.open(zipExport.blob, validateBookPackage, new AbortController().signal);
    const sameBytes = await Promise.all([...images].map(async ([path, blob]) => {
      const previous = state.bundledImages.get(path)?.blob;
      return previous && [...new Uint8Array(await previous.arrayBuffer())].join() === [...new Uint8Array(await blob.arrayBuffer())].join();
    }));
    document.getElementById("bookZipExport").close();
    return { identical: JSON.stringify(bookPackage) === JSON.stringify(state.bookPackage), sameBytes };
  });
  assert.equal(unchanged.identical, true, "Re-export keeps the imported paths and asset IDs");
  assert.deepEqual(unchanged.sameBytes, [true, true], "Re-export retains the exact WebP bytes");
  await maker.evaluate(() => {
    document.getElementById("toggleBookEditing").click();
    document.querySelector("#pageViewport img").click();
    const form = document.getElementById("bookEditingForm");
    form.elements.caption.value = "Edited after reopening";
    form.elements.fileName.value = "resumed-art";
    form.elements.crop.checked = true;
    form.elements.w.value = "50";
    form.requestSubmit(form.querySelector('button[value="save"]'));
  });
  await maker.until(() => !document.getElementById("bookEditing").open &&
    document.querySelector("#pageViewport img")?.naturalWidth === 8, "Crop editor reads an imported bundled image");
  await maker.evaluate(() => document.getElementById("exportButton").click());
  await maker.until(() => !document.getElementById("downloadBookZip").disabled, "Edited reopened ZIP ready");
  const resumedZip = await maker.evaluate(async () => {
    const bytes = [...new Uint8Array(await zipExport.blob.arrayBuffer())];
    document.getElementById("bookZipExport").close();
    return bytes;
  });
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for resumed book");
  await reader.upload("jsonInput", "resumed-book.zip", resumedZip);
  await reader.until(() => {
    const images = [...document.querySelectorAll("#pageViewport img[src^='blob:']")];
    return images.length === 2 && images[0].naturalWidth === 8 && images[1].naturalWidth === 16 &&
      document.querySelector("#pageViewport figcaption").textContent === "Edited after reopening";
  }, "Reader opens edited and unchanged images from a resumed ZIP");
  await maker.upload("jsonInput", "older-png-book.zip", legacyZip);
  await maker.until(() => state.bundledImages.size === 2 && document.querySelector("#pageViewport img")?.naturalWidth === 12,
    "Bookmaker reopens older PNG ZIP files");
  const oldUrls = await maker.evaluate(() => [...state.bundledImages.values()].map(({ url }) => url));
  await maker.upload("jsonInput", "saved-book.json", standalone);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo" && !state.bundledImages.size, "Standalone JSON reopened");
  assert.equal(await maker.evaluate(() => document.getElementById("attachPdf").disabled), false);
  await maker.upload("pdfInput", "reopened-json.pdf", [...fixturePdf()]);
  await maker.until(() => document.getElementById("imageRecovery").open, "PDF attachment opens after a JSON import");
  await maker.evaluate(() => document.getElementById("imageRecovery").close());
  await maker.evaluate(() => document.getElementById("reviewPdf").click());
  await maker.until(() => document.getElementById("pdfInspector").open && !document.getElementById("pdfPageBody").hidden,
    "Matching PDF renders beside a reopened JSON book");
  await maker.evaluate(() => document.getElementById("pdfInspector").close());
  const released = await maker.evaluate(async (urls) => Promise.all(urls.map((url) => fetch(url).then(() => false, () => true))), oldUrls);
  assert.deepEqual(released, [true, true], "Replacing a book releases its bundled image URLs");
  await maker.evaluate(() => {
    document.getElementById("toggleBookEditing").click();
    document.querySelector("#pageViewport [data-book-edit]").click();
    const form = document.getElementById("bookEditingForm");
    form.elements.text.value = "A reopened JSON heading";
    form.requestSubmit(form.querySelector('button[value="save"]'));
  });
  assert.equal(await maker.evaluate(() => state.entries[0].blocks.find(({ type }) => type === "heading").text), "A reopened JSON heading");
  await maker.evaluate((zip, json) => {
    const input = document.getElementById("jsonInput");
    for (const [name, content] of [["slow.zip", Uint8Array.from(zip)], ["latest.json", json]]) {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    }
  }, originalZip, standalone);
  await maker.until(() => document.getElementById("sourceStatus").textContent.includes("latest.json") && !state.bundledImages.size,
    "A later JSON import wins over an unfinished ZIP import");
}

async function inspectPdfDownload(maker, crop) {
  return maker.evaluate(async (crop) => {
    const createURL = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let blob;
    let timer;
    try {
      const filename = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(document.getElementById("pdfPageStatus").textContent || "PDF download missing.")), 6000);
        URL.createObjectURL = (value) => { blob = value; return createURL.call(URL, value); };
        HTMLAnchorElement.prototype.click = function () { resolve(this.download); };
        if (!crop) {
          document.querySelector('#pdfImages button').click();
          return;
        }
        document.getElementById("pdfCrop").click();
        const canvas = document.getElementById("pdfPageCanvas");
        const rect = canvas.getBoundingClientRect();
        canvas.setPointerCapture = () => {}; // No native pointer is held for these synthetic events.
        for (const [type, ratio] of [["pointerdown", 0.1], ["pointerup", 0.25]]) {
          canvas.dispatchEvent(new PointerEvent(type, {
            isPrimary: true, pointerId: 1, button: 0, clientX: rect.left + rect.width * ratio, clientY: rect.top + rect.height * ratio
          }));
        }
        delete canvas.setPointerCapture;
        document.getElementById("pdfSaveCrop").click();
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      let lossy = false;
      for (let index = 12; index + 8 <= bytes.length;) {
        if (String.fromCharCode(...bytes.subarray(index, index + 4)) === "VP8 ") lossy = true;
        const length = view.getUint32(index + 4, true);
        index += 8 + length + (length % 2);
      }
      const bitmap = await createImageBitmap(blob);
      const sample = document.createElement("canvas");
      sample.width = bitmap.width;
      sample.height = bitmap.height;
      const context = sample.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { filename, type: blob.type, width: sample.width, height: sample.height, lossy,
        alpha: [0, 7, 15].map((x) => context.getImageData(x, 0, 1, 1).data[3]) };
    } finally {
      clearTimeout(timer);
      URL.createObjectURL = createURL;
      HTMLAnchorElement.prototype.click = click;
    }
  }, crop);
}

async function smokeBulkEditing(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Bulk editing demo");
  await maker.upload("mdInput", "bulk-editing.md", [
    "## First Book", "### Sample", "First sample wording.", "", "Other opening paragraph.",
    "![background image](missing-backdrop-a.png)", "![Books Image](missing-art-a.png)",
    "## Second Book", "### Sample", "Second sample wording.", "", "Other closing paragraph.",
    "![Background Image](missing-backdrop-b.png)", "![Books Image](missing-art-b.png)"
  ].join("\n"));
  await maker.until(() => state.entries[0]?.title === "First Book", "Bulk editing fixture");
  const counts = await maker.evaluate(() => {
    const byId = (id) => document.getElementById(id);
    const form = byId("bookEditingForm");
    const pick = (value) => {
      form.elements.scope.value = value;
      form.elements.scope.dispatchEvent(new Event("change"));
      return form.querySelector("[data-scope-count]").textContent;
    };
    const submit = (value = "save") => form.requestSubmit(form.querySelector(`button[value="${value}"]`));
    const clickText = (tag, text) => [...document.querySelectorAll(`#pageViewport ${tag}`)].find((element) => element.textContent === text).click();
    byId("toggleBookEditing").click();
    document.querySelector('#pageViewport img[alt="background image"]').click();
    const removed = pick("image-label");
    const removeButton = form.querySelector('button[value="remove"]').textContent;
    submit("remove");

    clickText("p", "First sample wording.");
    const paragraphs = pick("section-position");
    form.elements.format.value = "book-quote";
    form.elements.text.value = "Do not copy this wording.";
    submit();

    clickText("p", "Other opening paragraph.");
    const sameFormat = pick("paragraph-style");
    form.elements.format.value = "book-callout";
    form.elements.replaceText.checked = true;
    form.elements.text.value = "Shared callout wording.";
    submit();

    clickText("h3", "Sample");
    pick("heading");
    form.elements.text.value = "Excerpt";
    submit();

    document.querySelector('#pageViewport img[alt="Books Image"]').click();
    pick("image-label");
    form.elements.width.value = "45";
    form.elements.caption.value = "Shared artwork caption";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 12;
    const data = Uint8Array.from(atob(canvas.toDataURL().split(",")[1]), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], "shared-art.png", { type: "image/png" }));
    form.elements.upload.files = transfer.files;
    form.elements.crop.checked = true;
    form.elements.w.value = "50";
    submit();
    return { removed, removeButton, paragraphs, sameFormat };
  });
  assert.equal(counts.removed, "2 images in 2 entries.");
  assert.equal(counts.removeButton, "Remove 2 matching images");
  assert.equal(counts.paragraphs, "2 blocks in 2 entries.");
  assert.equal(counts.sameFormat, "2 blocks in 2 entries.");
  await maker.until(() => !document.getElementById("bookEditing").open && state.recoveredImages.size === 2, "Bulk image changes applied");
  const result = await maker.evaluate(async () => {
    const book = window.bookEditing.exportPackage();
    const zip = await window.bookArchive.create(book, (block) => state.previewImages.get(block));
    const archive = await JSZip.loadAsync(await zip.blob.arrayBuffer());
    return {
      text: book.entries.map((entry) => entry.blocks.filter((block) => block.type === "paragraph").map(({ text, style }) => [text, style || ""])),
      headings: book.entries.map((entry) => entry.blocks.find(({ level }) => level === 3).text),
      images: book.entries.map((entry) => entry.blocks.filter(({ type }) => type === "image").map((block) => ({ width: block.width, caption: block.caption, fileName: state.previewImages.get(block).fileName }))),
      urls: book.assets.map(({ src }) => src),
      files: Object.keys(archive.files).filter((name) => name.endsWith(".webp")),
    };
  });
  assert.deepEqual(result.text, [
    [["First sample wording.", "book-quote"], ["Shared callout wording.", "book-callout"]],
    [["Second sample wording.", "book-quote"], ["Shared callout wording.", "book-callout"]]
  ]);
  assert.deepEqual(result.headings, ["Excerpt", "Excerpt"]);
  assert.deepEqual(result.images, [[{ width: "45%", caption: "Shared artwork caption", fileName: "shared-art.webp" }],
    [{ width: "45%", caption: "Shared artwork caption", fileName: "shared-art-2.webp" }]]);
  assert.ok(result.urls.every((url) => !url.includes("backdrop")));
  assert.deepEqual(result.files, ["images/shared-art.webp", "images/shared-art-2.webp"]);
}

async function smokeBookEditing(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Book editing demo");
  await maker.upload("mdInput", "editing.md", [
    "## Zeta Book", "### Description", "An editable sentence.", "", "![Books Image](missing-cover.png) {position:absolute}",
    "{{note A converted note}}", "### Secret", "Keep this sentence private.", "", "![Secret Art](secret-art.png)",
    "### Sample", "A sample of the writing.", "## Alpha Book", "### Secret", "An approved exception.",
    "### Description", "Another description.", "![background](missing-decoration.png)"
  ].join("\n"));
  await maker.until(() => state.entries[0]?.title === "Zeta Book", "Editing fixture");
  await maker.evaluate(() => {
    const click = (id) => document.getElementById(id).click();
    const form = document.getElementById("bookEditingForm");
    const submit = (value = "save") => form.requestSubmit(form.querySelector(`button[value="${value}"]`));
    click("toggleBookEditing");
    [...document.querySelectorAll("[data-edit-block] p")].find((p) => p.textContent === "An editable sentence.").click();
    form.elements.text.value = "Revised sentence.";
    form.elements.format.value = "book-quote";
    submit();
    document.querySelector("[data-book-add='3']").click();
    form.elements.text.value = "Remove this temporary paragraph.";
    form.elements.format.value = "paragraph";
    submit();
    [...document.querySelectorAll("[data-edit-block] p")].find((p) => p.textContent === "Remove this temporary paragraph.").click();
    submit("remove");

    click("reviewSourceItems");
    for (const label of document.querySelectorAll(".book-source-list label")) {
      const name = label.firstElementChild.firstChild.textContent.trim();
      label.querySelector("select").value = { "Books Image": "hide", note: "callout", background: "keep" }[name] || "";
    }
    submit();
    click("editSectionRules");
    const secret = [...document.querySelectorAll("#sectionRuleRows li")].find((row) => row.textContent.startsWith("Secret"));
    secret.querySelector("input").click();
    secret.querySelector("button[aria-label$=' up']").click();
    submit();

    click("organizeBook");
    form.elements.scope.value = "sections";
    form.elements.scope.dispatchEvent(new Event("change"));
    const sample = [...document.querySelectorAll("#bookOrderRows li")].find((row) => row.textContent.startsWith("Sample"));
    sample.querySelector("button[aria-label$=' up']").click();
    form.elements.scope.value = "entries";
    form.elements.scope.dispatchEvent(new Event("change"));
    click("sortBookEntries");
    submit();

    const secretImage = [...document.querySelectorAll("#pageViewport [data-edit-block] img")].find((img) => img.alt === "Secret Art");
    secretImage.click();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 12;
    const data = Uint8Array.from(atob(canvas.toDataURL().split(",")[1]), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], "private-art.png", { type: "image/png" }));
    form.elements.upload.files = transfer.files;
    form.elements.alt.value = "Private illustration";
    form.elements.caption.value = "Private caption";
    form.elements.width.value = "42";
    form.elements.crop.checked = true;
    form.elements.w.value = "50";
    submit();
  });
  await maker.until(() => {
    const image = document.querySelector('#pageViewport img[alt="Private illustration"]');
    return !document.getElementById("bookEditing").open && image?.naturalWidth === 6;
  }, "Uploaded image crop renders in preview");
  const editions = await maker.evaluate(() => {
    const button = (id) => document.getElementById(id);
    const form = button("bookEditingForm");
    const headings = () => [...document.querySelectorAll("#pageViewport h3")];
    headings().find((heading) => heading.textContent === "Sample").click();
    form.elements.destination.value = state.entries[0].id;
    form.requestSubmit(form.querySelector('button[value="save"]'));
    button("previousButton").click();
    headings().find((heading) => heading.textContent === "Secret").click();
    form.elements.visibility.value = "include";
    form.requestSubmit(form.querySelector('button[value="save"]'));
    button("openHeadings").click();
    const title = document.querySelector('input[aria-label="Title for H3 Sample"]');
    title.value = "Excerpt";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    button("previewHeadings").click();
    button("applyHeadings").click();
    button("toggleBookEditing").click();
    const full = window.bookEditing.exportPackage();
    button("exportEdition").value = "player";
    button("exportEdition").dispatchEvent(new Event("change"));
    const playerButton = button("exportButton").textContent;
    const player = window.bookEditing.exportPackage();
    button("exportEdition").value = "full";
    button("exportEdition").dispatchEvent(new Event("change"));
    return { full, player, playerButton };
  });
  assert.deepEqual(editions.full.entries.map(({ title }) => title), ["Alpha Book", "Zeta Book"]);
  assert.ok(editions.full.entries[0].blocks.some(({ text }) => text === "A sample of the writing."));
  assert.ok(editions.full.entries[0].blocks.some(({ text }) => text === "Excerpt"));
  assert.ok(editions.full.entries[1].blocks.some(({ text, style }) => text === "Revised sentence." && style === "book-quote"));
  assert.ok(editions.full.entries[1].blocks.some(({ text, style }) => text === "A converted note" && style === "book-callout"));
  assert.ok(editions.full.assets.some(({ src }) => src === "missing-decoration.png"));
  assert.ok(!editions.full.assets.some(({ src }) => src === "missing-cover.png"));
  assert.equal(editions.playerButton, "Export JSON");
  assert.ok(!JSON.stringify(editions.player).match(/Keep this sentence private|Private caption|secret-art\.png/));
  assert.ok(JSON.stringify(editions.player).includes("An approved exception."));

  const playerDownload = await maker.evaluate(async () => {
    const edition = document.getElementById("exportEdition");
    const exportButton = document.getElementById("exportButton");
    const createURL = URL.createObjectURL;
    const anchorClick = HTMLAnchorElement.prototype.click;
    let blob, filename;
    try {
      URL.createObjectURL = (value) => { blob = value; return createURL.call(URL, value); };
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      edition.value = "player";
      edition.dispatchEvent(new Event("change"));
      exportButton.click();
      return { filename, book: JSON.parse(await blob.text()), visible: edition.getBoundingClientRect().width > 0 };
    } finally {
      URL.createObjectURL = createURL;
      HTMLAnchorElement.prototype.click = anchorClick;
      edition.value = "full";
      edition.dispatchEvent(new Event("change"));
    }
  });
  assert.ok(playerDownload.visible);
  assert.equal(playerDownload.filename, "editing-player.json");
  assert.deepEqual(playerDownload.book, editions.player);

  await maker.evaluate(() => document.getElementById("exportButton").click());
  await maker.until(() => !document.getElementById("downloadBookZip").disabled, "Edited full edition ZIP ready");
  const zip = await maker.evaluate(async () => {
    const createURL = URL.createObjectURL;
    let blob;
    URL.createObjectURL = (value) => { blob = value; return createURL.call(URL, value); };
    HTMLAnchorElement.prototype.click = () => {};
    document.getElementById("downloadBookZip").click();
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for edited book");
  await reader.upload("jsonInput", "edited-book.zip", zip);
  await reader.until(() => readerState.entries[0]?.title === "Alpha Book", "Ordered entries opened in Reader");
  await reader.evaluate(() => document.getElementById("nextButton").click());
  await reader.until(() => {
    const img = document.querySelector('#pageViewport img[alt="Private illustration"]');
    return img?.naturalWidth === 6 && img.closest("figure").style.width === "42%" &&
      img.closest("figure").querySelector("figcaption").textContent === "Private caption" &&
      document.querySelector("#pageViewport blockquote")?.textContent === "Revised sentence.";
  }, "Reader renders edited text, image crop, width, and accessible text");
}

async function smokeTableAndListEditing(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Table and list editing demo");
  const sample = "| Item | Value |\n| --- | --- |\n| Rope | 5 |\n\n- Lantern\n- Oil";
  await maker.upload("mdInput", "table-and-list.md", `## First Book\n${sample}\n\n## Second Book\n${sample}`);
  await maker.until(() => state.entries[0]?.title === "First Book", "Table and list editing fixture");
  const book = await maker.evaluate(async () => {
    const form = document.getElementById("bookEditingForm");
    const click = (selector) => form.querySelector(selector).click();
    const submit = () => form.requestSubmit(form.querySelector('button[value="save"]'));
    const fill = (name, value) => {
      const field = form.querySelector(`[aria-label="${name}"]`);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const add = (type) => {
      document.querySelector("#pageViewport [data-book-add]").click();
      form.elements.format.value = type;
      form.elements.format.dispatchEvent(new Event("change"));
      submit();
    };
    const button = (text) => [...form.querySelectorAll("button")].find((button) => button.textContent === text).click();
    document.getElementById("toggleBookEditing").click();
    document.querySelector("#pageViewport table td").click();
    form.elements.scope.value = "identical";
    fill("Column 1 heading", "Supply");
    click('[aria-label="Remove column 2"]');
    button("Add column");
    fill("Column 2 heading", "Stock");
    fill("Row 1, column 2", "7");
    button("Add row");
    fill("Row 2, column 1", "Torch");
    fill("Row 2, column 2", "9");
    click('[aria-label="Remove row 1"]');
    submit();

    document.querySelector("#pageViewport .book-edit-block ul li").click();
    fill("Bullet 1", "Hooded lantern");
    click('[aria-label="Remove bullet 2"]');
    button("Add bullet");
    fill("Bullet 2", "Matches");
    submit();
    add("list");
    fill("Bullet 1", "Bedroll");
    submit();
    add("table");
    fill("Column 1 heading", "Task");
    fill("Row 1, column 1", "Watch");
    submit();

    const createURL = URL.createObjectURL;
    const anchorClick = HTMLAnchorElement.prototype.click;
    let blob;
    try {
      URL.createObjectURL = (file) => { blob = file; return createURL.call(URL, file); };
      HTMLAnchorElement.prototype.click = () => {};
      document.getElementById("exportButton").click();
      return JSON.parse(await blob.text());
    } finally {
      URL.createObjectURL = createURL;
      HTMLAnchorElement.prototype.click = anchorClick;
    }
  });
  const editedTable = { type: "table", columns: ["Supply", "Stock"], rows: [["Torch", "9"]] };
  assert.deepEqual(book.entries[0].blocks.slice(1), [
    { type: "table", columns: ["Task", ""], rows: [["Watch", ""]] },
    { type: "list", items: ["Bedroll"] }, editedTable, { type: "list", items: ["Hooded lantern", "Matches"] }
  ]);
  assert.deepEqual(book.entries[1].blocks.slice(1), [editedTable, { type: "list", items: ["Lantern", "Oil"] }]);
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for edited tables and lists");
  await reader.upload("jsonInput", "edited-table-and-list.json", JSON.stringify(book));
  await reader.until(() => {
    const page = document.getElementById("pageViewport");
    return page.querySelectorAll("table").length === 2 && page.querySelectorAll(".page-content ul").length === 2 &&
      page.textContent.includes("Hooded lantern") && page.textContent.includes("Torch");
  }, "Reader renders edited and newly added tables and lists");
}

async function smokeFindAndReplace(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Find and replace demo");
  const source = [
    "## Treacherous Waters", "#### Backer's Name: {{color:#a00,font-weight:bold Emrauld}}", "{margin-top:-5px}",
    "{{note", "#### Another Backer: {{font-family:'Old Standard TT' Emrauld}}", "}}", "A harbor introduction.",
    "1. Find the harbor.", "   Continue at dawn.", "", "2) Leave the harbor.", "3. Return home.",
    "", "A paragraph after the list.", "", "| Location | Hint |", "| --- | --- |", "| Harbor | Guard |", "",
    "![harbor image](missing-harbor.png)", "## Harbor Story", "A harbor secret.", "### Secret", "harbor clue."
  ].join("\n");
  await maker.upload("mdInput", "replace-fixture.md", source);
  await maker.until(() => state.entries[0]?.title === "Treacherous Waters", "Replacement fixture ready");
  const imported = await maker.evaluate(() => ({
    headings: state.entries[0].blocks.filter(({ type }) => type === "heading").map(({ text }) => text),
    list: state.entries[0].blocks.find(({ type }) => type === "list"),
    text: document.getElementById("pageViewport").textContent
  }));
  assert.ok(imported.headings.includes("Backer's Name: Emrauld"));
  assert.ok(imported.headings.includes("Another Backer: Emrauld"));
  assert.deepEqual(imported.list.items, ["Find the harbor. Continue at dawn.", "Leave the harbor.", "Return home."]);
  assert.equal(imported.list.ordered, true);
  assert.equal(imported.list.start, 1);
  assert.ok(!imported.text.includes("margin-top"));
  const undoBaseline = await maker.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    updateImageRecovery(state.imageSlots[0], { blob: await window.bookArchive.encodeWebp(canvas), fileName: "harbor.webp", caption: "harbor image" });
    return JSON.stringify(window.bookEditing.exportPackage());
  });
  const replacements = await maker.evaluate(() => {
    const open = () => document.getElementById("replaceBookText").click();
    const form = document.getElementById("bookEditingForm");
    const set = (name, value) => {
      form.elements[name].value = value;
      form.elements[name].dispatchEvent(new Event("input", { bubbles: true }));
    };
    const submit = () => form.requestSubmit(form.querySelector('button[value="save"]'));
    open();
    set("query", "harbor");
    set("replacement", "Quay $&");
    const summary = document.getElementById("replaceSummary").textContent;
    const sourceUnchanged = state.entries[0].blocks.some(({ text }) => text === "A harbor introduction.");
    submit();
    const firstOnly = state.entries[1].blocks.some(({ text }) => text === "A harbor secret.");
    open();
    set("query", "harbor");
    set("replacement", "Port");
    set("replaceScope", "book");
    submit();
    open();
    set("query", "$&");
    set("replacement", "");
    set("replaceScope", "book");
    submit();
    return { summary, sourceUnchanged, firstOnly, book: window.bookEditing.exportPackage() };
  });
  assert.match(replacements.summary, /6 matches in 1 entry/);
  assert.equal(replacements.sourceUnchanged, true);
  assert.equal(replacements.firstOnly, true);
  const [first, second] = replacements.book.entries;
  assert.equal(first.blocks.find(({ type }) => type === "list").items[0], "Find the Quay . Continue at dawn.");
  assert.equal(first.blocks.find(({ type }) => type === "table").rows[0][0], "Quay ");
  assert.equal(first.blocks.find(({ type }) => type === "image").caption, "Quay  image");
  assert.equal(second.title, "Port Story");
  assert.ok(second.blocks.some(({ text }) => text === "A Port secret."));
  assert.equal(replacements.book.assets[0].src, "missing-harbor.png");
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for replacements");
  await reader.upload("jsonInput", "replaced-book.json", JSON.stringify(replacements.book));
  await reader.until(() => {
    const page = document.getElementById("pageViewport");
    return page.textContent.includes("Backer's Name: Emrauld") && page.querySelectorAll("ol li").length === 3 && page.querySelector("ol").start === 1;
  }, "Reader displays backer and preserves list numbering");
  const undoResult = await maker.evaluate(() => {
    const button = document.getElementById("undoBookReplacement");
    button.click();
    const restoredLiteral = state.entries[0].blocks.some(({ text }) => text === "A Quay $& introduction.");
    button.click();
    const restoredSecondEntry = state.entries[1].title === "Harbor Story";
    button.click();
    return { restoredLiteral, restoredSecondEntry, book: JSON.stringify(window.bookEditing.exportPackage()),
      caption: [...state.recoveredImages.values()][0].caption, disabled: button.disabled,
      imageLoaded: document.querySelector("#pageViewport img").src.startsWith("blob:") };
  });
  assert.equal(undoResult.restoredLiteral, true);
  assert.equal(undoResult.restoredSecondEntry, true);
  assert.equal(undoResult.book, undoBaseline);
  assert.equal(undoResult.caption, "harbor image");
  assert.equal(undoResult.disabled, true);
  assert.equal(undoResult.imageLoaded, true);
  await maker.evaluate(() => {
    document.getElementById("replaceBookText").click();
    const form = document.getElementById("bookEditingForm");
    for (const [name, value] of [["query", "harbor"], ["replacement", "port"]]) {
      form.elements[name].value = value;
      form.elements[name].dispatchEvent(new Event("input", { bubbles: true }));
    }
    form.requestSubmit(form.querySelector('button[value="save"]'));
  });
  assert.equal(await maker.evaluate(() => document.getElementById("undoBookReplacement").disabled), false);
  await maker.evaluate(() => {
    document.getElementById("toggleBookEditing").click();
    document.querySelector("#pageViewport ol li").click();
    const form = document.getElementById("bookEditingForm");
    const first = form.querySelector('[aria-label="Item 1"]');
    first.value = "Revised first step.";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit(form.querySelector('button[value="save"]'));
  });
  assert.equal(await maker.evaluate(() => document.querySelector("#pageViewport ol li").textContent), "Revised first step.");
  assert.equal(await maker.evaluate(() => document.getElementById("undoBookReplacement").disabled), true, "Later content edits start a new replacement history");
}

async function smokeOrganizationAndCaptions(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Organization and caption demo");
  const a = "missing-caption-a.png";
  const b = "missing-caption-b.png";
  await maker.upload("mdInput", "organization-captions.md", [
    "## One", `![Art](${a})`, "### Keep", "- First", "- Second", "#### Remove me", "Remove this detail.",
    "##### Child", "Remove this child.", "### Drop section", "Remove this section.",
    "## Two", `![Art](${a})`, `![Other art](${b})`, "## Remove entry", "Remove this entry text."
  ].join("\n"));
  await maker.until(() => state.entries[0]?.title === "One", "Caption fixture ready");
  const result = await maker.evaluate(async ({ a, b }) => {
    const form = document.getElementById("bookEditingForm");
    const open = (id) => document.getElementById(id).click();
    const set = (name, value) => {
      const control = form.elements[name];
      control.value = value;
      control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    };
    const save = () => form.requestSubmit(form.querySelector('button[value="save"]'));
    const slot = state.imageSlots[0];
    const image = document.createElement("canvas");
    image.width = image.height = 8;
    updateImageRecovery(slot, { blob: await window.bookArchive.encodeWebp(image), fileName: "caption-art.webp", caption: "Original art caption" });
    open("setImageCaptions");
    save();
    const h2 = window.bookEditing.exportPackage().entries.flatMap((entry) => entry.blocks.filter(({ type }) => type === "image").map(({ caption }) => caption));
    open("setImageCaptions");
    set("captionSource", "mapping");
    set("captionUrls", `${a}\n${b}`);
    set("captionValues", "Shared caption");
    const mismatched = form.querySelector('button[value="save"]').disabled;
    set("captionValues", "Shared caption\nOther caption");
    save();
    const captions = window.bookEditing.exportPackage().entries.flatMap((entry) => entry.blocks.filter(({ type }) => type === "image").map(({ caption, alt }) => [caption, alt]));
    open("organizeBook");
    form.querySelector('[aria-label="Remove Remove entry and content"]').click();
    set("scope", "headings");
    form.querySelector('[aria-label="Remove Remove me and content"]').click();
    set("scope", "sections");
    form.querySelector('[aria-label="Remove Drop section and content"]').click();
    const staged = state.entries.length === 3 && state.entries[0].blocks.some(({ text }) => text === "Remove this detail.");
    save();
    open("toggleBookEditing");
    document.querySelector("#pageViewport ul li").click();
    set("listStyle", "numbered");
    set("listStart", "4");
    save();
    const numbered = document.querySelector("#pageViewport ol")?.start;
    document.querySelector("#pageViewport ol li").click();
    set("listStyle", "bullet");
    save();
    const bullets = document.querySelectorAll("#pageViewport .page-content ul li").length;
    document.querySelector("#pageViewport ul li").click();
    set("listStyle", "numbered");
    set("listStart", "4");
    save();
    const book = window.bookEditing.exportPackage();
    const { blob } = await window.bookArchive.create(book, (block) => state.previewImages.get(block));
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const packaged = JSON.parse(await zip.file("book.json").async("string"));
    return { h2, mismatched, captions, staged, numbered, bullets, book, packaged, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
  }, { a, b });
  assert.deepEqual(result.h2, ["One", "Two", "Two"]);
  assert.equal(result.mismatched, true);
  assert.deepEqual(result.captions, [["Shared caption", "Original art caption"], ["Shared caption", "Art"], ["Other caption", "Other art"]]);
  assert.equal(result.staged, true);
  assert.equal(result.numbered, 4);
  assert.equal(result.bullets, 2);
  assert.deepEqual(result.book.entries.map(({ title }) => title), ["One", "Two"]);
  assert.ok(!JSON.stringify(result.book).includes("Remove this"));
  assert.equal(result.packaged.entries[0].blocks.find(({ type }) => type === "image").caption, "Shared caption");
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for caption export");
  await reader.upload("jsonInput", "captions.zip", result.bytes);
  await reader.until(() => {
    const page = document.getElementById("pageViewport");
    return page.querySelector("ol")?.start === 4 && page.querySelector("img")?.naturalWidth === 8 && page.querySelector("figcaption")?.textContent === "Shared caption";
  }, "Reader displays standalone captions and numbered list after removal");
  const empty = await maker.evaluate(() => {
    document.getElementById("organizeBook").click();
    const form = document.getElementById("bookEditingForm");
    while (form.querySelector('button[aria-label^="Remove "]')) form.querySelector('button[aria-label^="Remove "]').click();
    form.requestSubmit(form.querySelector('button[value="save"]'));
    return { entries: state.entries.length, preview: document.getElementById("pageViewport").textContent, counter: document.getElementById("currentPage").textContent };
  });
  assert.deepEqual(empty, { entries: 0, preview: "", counter: "0" });
  const emptyBook = await maker.evaluate(() => JSON.stringify(window.bookEditing.exportPackage()));
  await reader.upload("jsonInput", "empty-book.json", emptyBook);
  await reader.until(() => document.getElementById("currentPage").textContent === "0" &&
    !document.getElementById("pageViewport").textContent, "Reader clears the previous book after every entry was removed");
}

async function smokePartsAndBreaks(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Parts fixture maker");
  await maker.upload("mdInput", "parts-and-breaks.md", [
    "# Part One", "## Alpha", "First<br>Second<br />Third", "<BR>Fourth", "",
    "- List<br/>item", "", "| Name<br>Detail | Value |", "| --- | --- |", "| A<br>B | 7 |",
    "### Scroll target", "## Beta", "A second entry.", "# Part Two", "## Gamma", "A third entry."
  ].join("\n"));
  await maker.until(() => state.entries[0]?.title === "Alpha", "Parts fixture imported");
  const result = await maker.evaluate(() => {
    const contents = document.getElementById("contents");
    const rows = () => [...contents.children].map((row) => row.querySelector(".page-title")?.textContent);
    const initial = rows();
    const partLabels = [...contents.querySelectorAll(".contents-part")];
    const staticParts = partLabels.every((row) => row.tabIndex === -1 && !row.querySelector("a, button"));
    const paragraph = document.querySelector("#pageViewport p");
    const breaks = [paragraph.querySelectorAll("br").length, document.querySelector("#pageViewport li").querySelectorAll("br").length,
      document.querySelector("#pageViewport th").querySelectorAll("br").length, document.querySelector("#pageViewport td").querySelectorAll("br").length];
    const alphaHasSection = Boolean(contents.querySelector("a[data-section]"));
    const search = document.getElementById("searchInput");
    search.value = "beta";
    search.dispatchEvent(new Event("input"));
    const childSearch = rows();
    search.value = "part two";
    search.dispatchEvent(new Event("input"));
    const partSearch = rows();
    search.value = "";
    search.dispatchEvent(new Event("input"));
    contents.querySelector('button[data-page="2"]').click();
    return { initial, staticParts, breaks, alphaHasSection, childSearch, partSearch, active: state.currentPage,
      book: window.bookEditing.exportPackage() };
  });
  const expected = ["Part One", "Alpha", "Beta", "Part Two", "Gamma"];
  assert.deepEqual(result.initial, expected);
  assert.ok(result.staticParts);
  assert.deepEqual(result.breaks, [3, 1, 1, 1]);
  assert.ok(result.alphaHasSection);
  assert.deepEqual(result.childSearch, ["Part One", "Beta"]);
  assert.deepEqual(result.partSearch, ["Part Two", "Gamma"]);
  assert.equal(result.active, 2);
  assert.deepEqual(result.book.entries.map(({ title }) => title), ["Alpha", "Beta", "Gamma"]);
  const paragraph = result.book.entries[0].blocks.find(({ type }) => type === "paragraph");
  assert.equal(paragraph.text, "First\nSecond\nThird\nFourth");
  // Older JSON with literal HTML break tags must display correctly too.
  paragraph.text = "First<br>Second<br />Third\nFourth";
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Parts fixture reader");
  await reader.upload("jsonInput", "parts-and-breaks.json", JSON.stringify(result.book));
  await reader.until(() => readerState.entries[0]?.title === "Alpha", "Parts fixture opened in Reader");
  const read = await reader.evaluate(() => ({
    rows: [...document.getElementById("contents").children].map((row) => row.querySelector(".page-title")?.textContent),
    breaks: document.querySelector("#pageViewport p").querySelectorAll("br").length,
    staticParts: [...document.querySelectorAll(".contents-part")].every((row) => !row.querySelector("a, button"))
  }));
  assert.deepEqual(read.rows, expected);
  assert.equal(read.breaks, 3);
  assert.ok(read.staticParts);
  await maker.upload("jsonInput", "parts-and-breaks.json", JSON.stringify(result.book));
  await maker.until(() => state.visualEdits && state.entries[0]?.title === "Alpha", "Legacy JSON reopened in Maker");
  assert.equal(await maker.evaluate(() => state.entries[0].blocks.find(({ type }) => type === "paragraph").text), "First\nSecond\nThird\nFourth");
  await maker.evaluate(() => {
    document.getElementById("toggleBookEditing").click();
    document.querySelector("#pageViewport p").click();
    const form = document.getElementById("bookEditingForm");
    form.elements.text.value = "Edited<br>line";
    form.requestSubmit(form.querySelector('button[value="save"]'));
  });
  await maker.until(() => state.entries[0].blocks.find(({ type }) => type === "paragraph").text === "Edited\nline", "Edited breaks normalized");
  const edit = await maker.evaluate(() => {
    document.getElementById("openHeadings").click();
    const part = document.querySelector('input[aria-label="Title for H1 Part One"]');
    const entry = document.querySelector('input[aria-label="Title for H2 Alpha"]');
    part.value = "Renamed Part";
    entry.value = "Renamed Entry";
    entry.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("previewHeadings").click();
    const preview = [...document.querySelectorAll("#headingPreviewContents .heading-preview-part")].map((row) => row.textContent);
    document.getElementById("applyHeadings").click();
    return { preview, title: state.entries[0].title, rows: [...document.getElementById("contents").children].map((row) => row.querySelector(".page-title")?.textContent) };
  });
  assert.ok(edit.preview.some((title) => title.includes("Renamed Part")));
  assert.equal(edit.title, "Renamed Entry");
  assert.deepEqual(edit.rows, ["Renamed Part", "Renamed Entry", "Beta", "Part Two", "Gamma"]);
  // Previously exported books may store the H1 at the end of the prior entry or in a heading-only preamble.
  const firstPart = result.book.entries[0].blocks.shift();
  const secondPart = result.book.entries[2].blocks.shift();
  result.book.entries[1].blocks.push(secondPart);
  result.book.entries.unshift({ id: "legacy-preamble", title: "Welcome", order: 0, blocks: [firstPart] });
  await reader.upload("jsonInput", "legacy-parts.json", JSON.stringify(result.book));
  await reader.until(() => readerState.entries[0]?.title === "Welcome", "Legacy part blocks opened in Reader");
  const legacy = await reader.evaluate(() => ({
    rows: [...document.getElementById("contents").children].map((row) => row.querySelector(".page-title")?.textContent),
    count: document.getElementById("contentsCount").textContent
  }));
  assert.deepEqual(legacy.rows, expected);
  assert.equal(legacy.count, "3/3");
}

async function smokeHeadingGroupOrdering(browser, width) {
  const maker = await browser.page("bookmaker.html", width);
  await maker.until(() => state.bookPackage?.book.title === "Euphoria Demo", "Heading group ordering demo");
  await maker.upload("mdInput", "heading-order.md", [
    "## First", "Entry introduction.", "### Alpha", "Alpha introduction.", "#### A1", "A1 content.",
    "![Alpha art](missing-alpha.png)", "##### A1 child", "Deep child content.", "#### A2", "Remove A2 content.",
    "### Beta", "Beta introduction.", "#### B1", "B1 content.", "### Gamma", "Gamma content.", "## Second", "Second entry content."
  ].join("\n"));
  await maker.until(() => state.entries[0]?.title === "First", "Nested heading fixture ready");
  const result = await maker.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 9;
    updateImageRecovery(state.imageSlots[0], { blob: await window.bookArchive.encodeWebp(canvas), fileName: "alpha-art.webp", caption: "Alpha figure" });
    const form = document.getElementById("bookEditingForm");
    const scope = (value) => {
      form.elements.scope.value = value;
      form.elements.scope.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const move = (heading, direction) => form.querySelector(`[aria-label="Move ${heading} ${direction}"]`).click();
    const open = () => { document.getElementById("organizeBook").click(); scope("headings"); };
    const original = JSON.stringify(state.entries);
    open();
    move("Beta", "up");
    document.getElementById("bookEditing").close();
    const canceled = original === JSON.stringify(state.entries);
    open();
    move("A2", "up");
    move("Beta", "up");
    const row = (name) => form.querySelector(`[aria-label="Remove ${name} and content"]`).closest("li");
    const drag = (from, to) => {
      const transfer = new DataTransfer();
      const source = row(from);
      const target = row(to);
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
    };
    drag("A1", "A2");
    const childOrder = [...row("Alpha").querySelector("ol").children].map((item) => item.firstElementChild.textContent.trim());
    const beforeCrossGroup = form.querySelector("#bookOrderRows").textContent;
    drag("B1", "A2");
    const crossGroupUnchanged = form.querySelector("#bookOrderRows").textContent === beforeCrossGroup;
    form.querySelector('[aria-label="Remove A2 and content"]').click();
    move("Alpha", "down");
    scope("sections");
    move("Alpha", "up");
    scope("headings");
    const staged = original === JSON.stringify(state.entries);
    form.requestSubmit(form.querySelector('button[value="save"]'));
    const blocks = state.entries[0].blocks.map((block) => block.text || block.type);
    const packageData = window.bookEditing.exportPackage();
    document.getElementById("exportButton").click();
    return { canceled, childOrder, crossGroupUnchanged, staged, blocks, packageData };
  });
  assert.equal(result.canceled, true);
  assert.deepEqual(result.childOrder, ["H4 A1", "H4 A2"]);
  assert.equal(result.crossGroupUnchanged, true);
  assert.equal(result.staged, true);
  assert.deepEqual(result.blocks, ["First", "Entry introduction.", "Beta", "Beta introduction.", "B1", "B1 content.",
    "Alpha", "Alpha introduction.", "A1", "A1 content.", "image", "A1 child", "Deep child content.", "Gamma", "Gamma content."]);
  assert.equal(result.packageData.entries[1].title, "Second");
  await maker.until(() => !document.getElementById("downloadBookZip").disabled, "Moved heading ZIP ready");
  const zip = await maker.evaluate(async () => [...new Uint8Array(await zipExport.blob.arrayBuffer())]);
  const reader = await browser.page("index.html", width);
  await reader.until(() => readerState.bookPackage?.book.title === "Euphoria Demo", "Reader ready for moved headings");
  await reader.upload("jsonInput", "moved-headings.zip", zip);
  await reader.until(() => document.querySelector('#pageViewport img')?.naturalWidth === 9, "Moved illustration survives export");
  assert.deepEqual(await reader.evaluate(() => [...document.querySelectorAll("#pageViewport h3")].map(({ textContent }) => textContent)), ["Beta", "Alpha", "Gamma"]);
  assert.deepEqual(await reader.evaluate(() => readerState.entries[0].blocks.map((block) => block.text || block.type)), result.blocks);
}

async function smokeImageReload(browser, width) {
  const failedSource = "https://bookmaker-image.test/art.png";
  for (const page of ["bookmaker.html", "index.html"]) {
    const tab = await browser.page(page, width);
    await tab.until(() => document.getElementById("sourceStatus").textContent.includes("Loaded"), "Book ready for image reload");
    const imageData = await tab.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 6;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    let available = false;
    let imageRequests = 0;
    await tab.interceptImages("https://bookmaker-image.test/*", () => {
      imageRequests += 1;
      return available ? { responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: imageData }
        : { responseCode: 503, responseHeaders: [{ name: "Cache-Control", value: "max-age=600" }] };
    });
    const fixture = await tab.evaluate((source, data) => {
      const book = (typeof state === "undefined" ? readerState : state).bookPackage;
      return JSON.stringify({ ...book, entries: [{ id: "reload-test", title: "Reload test", order: 0, blocks: [
        { type: "paragraph", text: "Preserve this paragraph." },
        { type: "image", assetId: "healthy", role: "illustration", placement: "inline" },
        { type: "image", assetId: "failed", role: "illustration", placement: "inline" }
      ] }], assets: [
        { id: "healthy", src: `data:image/png;base64,${data}`, alt: "Loaded art", role: "illustration" },
        { id: "failed", src: source, alt: "Retry art", role: "illustration" }
      ] });
    }, failedSource, imageData);
    await tab.upload("jsonInput", "image-reload.json", fixture);
    await tab.until(() => document.getElementById("currentLabel").textContent === "Reload test", "Image retry fixture loaded");
    const original = await tab.evaluate(() => {
      const content = document.querySelector("#pageViewport .page-content");
      content.querySelector('img[alt="Loaded art"]').id = "reload-healthy";
      content.querySelector('img[alt="Retry art"]').id = "reload-missing";
      content.querySelectorAll("img").forEach((image) => { image.loading = "eager"; });
      document.getElementById("searchInput").value = "Keep my search";
      content.dataset.reloadCheck = "keep this entry";
      return document.getElementById("currentLabel").textContent;
    });
    await tab.until(() => document.querySelector("#reload-missing")?.complete && !document.querySelector("#reload-missing").naturalWidth &&
      document.querySelector("#reload-healthy")?.naturalWidth === 8, "One image fails and one loads");
    const requestsBefore = imageRequests;
    available = true;
    await tab.evaluate(() => document.getElementById("reloadImages").click());
    await tab.until(() => document.querySelector("#reload-missing")?.naturalWidth === 8 &&
      document.getElementById("notice").textContent.includes("1 of 1 images loaded."), "Failed image retries successfully");
    assert.ok(imageRequests > requestsBefore, "Retry makes a fresh request for the failed image");
    const unchanged = await tab.evaluate(() => ({
      entry: document.getElementById("currentLabel").textContent,
      search: document.getElementById("searchInput").value,
      marker: document.querySelector("#pageViewport .page-content").dataset.reloadCheck,
      healthy: document.getElementById("reload-healthy").getAttribute("src"),
      visible: document.getElementById("reloadImages").getBoundingClientRect().right <= innerWidth
    }));
    assert.deepEqual(unchanged, { entry: original, search: "Keep my search", marker: "keep this entry", healthy: `data:image/png;base64,${imageData}`, visible: true });
  }
}

function startChrome() {
  const executable = process.env.CHROME_BIN || (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "google-chrome");
  const args = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--remote-debugging-pipe"];
  if (base.protocol === "file:") args.push("--allow-file-access-from-files");
  const child = spawn(executable, [...args, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  const requestLogs = new Map();
  const imageInterceptors = new Map();
  let id = 0;
  let buffer = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("data", (data) => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === "Network.requestWillBeSent") {
        requestLogs.get(message.sessionId)?.push(message.params.request);
      }
      if (message.method === "Fetch.requestPaused") {
        const handler = imageInterceptors.get(message.sessionId);
        if (handler) call("Fetch.fulfillRequest", { requestId: message.params.requestId, ...handler(message.params.request) }, message.sessionId).catch(() => {});
      }
      pending.get(message.id)?.(message);
    }
  });

  function call(method, params, sessionId) {
    return new Promise((success, fail) => {
      const seq = ++id;
      const timeout = setTimeout(() => {
        pending.delete(seq);
        fail(spawnError || new Error(`Chrome timed out during ${method}.`));
      }, 15_000);
      pending.set(seq, (message) => {
        clearTimeout(timeout);
        pending.delete(seq);
        if (message.error) fail(new Error(message.error.message));
        else success(message.result);
      });
      child.stdio[3].write(JSON.stringify({ id: seq, method, params, sessionId }) + "\0");
    });
  }

  return {
    close: () => child.kill(),
    async page(file, width) {
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      const send = (method, params = {}) => call(method, params, sessionId);
      const requests = [];
      requestLogs.set(sessionId, requests);
      await send("Network.enable");
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const navigation = await send("Page.navigate", { url: new URL(file, base).href });
      if (navigation.errorText) throw new Error(navigation.errorText);
      async function evaluate(fn, ...args) {
        const expression = `(${fn})(...${JSON.stringify(args)})`;
        const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        return result.value;
      }
      async function until(fn, label) {
        for (let count = 0; count < 240; count += 1) {
          if (await evaluate(fn)) return;
          await new Promise((ready) => setTimeout(ready, 50));
        }
        const status = await evaluate(() => [...document.querySelectorAll('[role="status"], #sourceStatus')].map((element) => element.textContent.trim()).filter(Boolean).join(" · "));
        throw new Error(`Timed out waiting for ${label}. ${status}`);
      }
      await until(() => document.readyState === "complete" && location.protocol !== "about:", file);
      return {
        evaluate, until, requests,
        async interceptImages(pattern, handler) {
          imageInterceptors.set(sessionId, handler);
          await send("Fetch.enable", { patterns: [{ urlPattern: pattern, resourceType: "Image" }] });
        },
        upload: async (id, name, bytes) => {
          await send("Page.bringToFront");
          return evaluate((id, name, bytes) => {
          const input = document.getElementById(id);
          const transfer = new DataTransfer();
          transfer.items.add(new File([Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes], name));
          input.files = transfer.files;
          input.dispatchEvent(new Event("change"));
          }, id, name, bytes);
        }
      };
    }
  };
}

function fixturePdf() {
  const stream = (bytes, fields = "") => Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${fields} >>\nstream\n`), Buffer.from(bytes), Buffer.from("\nendstream")
  ]);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Art 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    stream(Buffer.alloc(16 * 16 * 3, 95), "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 9 0 R"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("q 80 0 0 80 40 40 cm /Art Do Q\nBT /F1 12 Tf 40 24 Td (Figure 1 Harbor Lantern) Tj ET"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 520] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>",
    stream("BT /F1 12 Tf 40 24 Td (Interlude) Tj ET"),
    stream(Buffer.from(Array.from({ length: 16 * 16 }, (_, index) => index % 16 < 5 ? 0 : index % 16 < 10 ? 128 : 255)),
      "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8")
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = ["0000000000 65535 f \n"];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(`${String(length).padStart(10, "0")} 00000 n \n`);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
    parts.push(bytes);
    length += bytes.length;
  });
  parts.push(Buffer.from(`xref\n0 ${offsets.length}\n${offsets.join("")}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}
