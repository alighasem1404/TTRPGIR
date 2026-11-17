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
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "lantern-at-the-harbor.png");
    await maker.evaluate(() => {
      document.getElementById("recoveryPageNumber").value = 2;
      document.getElementById("jumpRecoveryPage").requestSubmit();
    });
    await maker.until(() => document.getElementById("recoveryPosition").textContent.includes("Markdown page 2"), "Jump to Markdown page");
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "lantern-at-the-harbor-2.png");
    await maker.evaluate(() => document.getElementById("previousRecovery").click());
    await maker.evaluate(() => document.getElementById("nextRecoveryPage").click());
    assert.match(await maker.evaluate(() => document.getElementById("recoveryPosition").textContent), /Markdown page 2/);
    await maker.evaluate(() => document.getElementById("previousRecovery").click());
    await maker.until(() => !document.getElementById("pdfImageHighlight").hidden, "PDF pane and highlighted match");
    await maker.evaluate(() => document.getElementById("pdfNext").click());
    await maker.until(() => document.getElementById("pdfPageNumber").value === "2" &&
      !document.getElementById("pdfPageBody").hidden, "Next PDF page");
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
    assert.equal(await maker.evaluate(() => document.getElementById("recoveryFileName").value), "sample.png");
    await maker.evaluate(() => {
      document.getElementById("recoveryCaption").value = "Harbor Lantern";
      document.getElementById("recoveryForm").requestSubmit();
    });
    await maker.until(() => document.getElementById("recoveryPosition").textContent.includes("Image 2 of 2") &&
      document.getElementById("recoveryFileName").value === "sample-2.png" &&
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
      document.getElementById("recoveryFileName").value === "sample-2.png", "Naming persists on reopen");
    await maker.evaluate(() => {
      document.getElementById("recoveryForm").requestSubmit();
      document.getElementById("imageRecovery").close();
      document.getElementById("exportButton").click();
    });
    await maker.until(() => !document.getElementById("downloadBookZip").disabled, "ZIP ready");
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
    for (const request of maker.requests) {
      assert.ok(["GET", "HEAD"].includes(request.method) && !request.hasPostData, "No file upload request");
      assert.doesNotMatch(request.url, /local-source-smoke/);
      if (/pdf(?:\.worker|\.renderer)?\.min\.mjs(?:\?|$)/.test(request.url)) {
        assert.ok(request.url.startsWith(pdfBase.href), "PDF.js requests stay under the project site");
      }
    }
    await smokeBookEditing(browser, width);
    await smokeBulkEditing(browser, width);
  } finally {
    browser.close();
  }
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
      files: Object.keys(archive.files).filter((name) => name.endsWith(".png")),
    };
  });
  assert.deepEqual(result.text, [
    [["First sample wording.", "book-quote"], ["Shared callout wording.", "book-callout"]],
    [["Second sample wording.", "book-quote"], ["Shared callout wording.", "book-callout"]]
  ]);
  assert.deepEqual(result.headings, ["Excerpt", "Excerpt"]);
  assert.deepEqual(result.images, [[{ width: "45%", caption: "Shared artwork caption", fileName: "shared-art.png" }],
    [{ width: "45%", caption: "Shared artwork caption", fileName: "shared-art-2.png" }]]);
  assert.ok(result.urls.every((url) => !url.includes("backdrop")));
  assert.deepEqual(result.files, ["images/shared-art.png", "images/shared-art-2.png"]);
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
  assert.match(playerDownload.filename, /-player\.json$/);
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

function startChrome() {
  const executable = process.env.CHROME_BIN || (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "google-chrome");
  const args = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--remote-debugging-pipe"];
  if (base.protocol === "file:") args.push("--allow-file-access-from-files");
  const child = spawn(executable, [...args, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  const requestLogs = new Map();
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
        upload: (id, name, bytes) => evaluate((id, name, bytes) => {
          const input = document.getElementById(id);
          const transfer = new DataTransfer();
          transfer.items.add(new File([Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes], name));
          input.files = transfer.files;
          input.dispatchEvent(new Event("change"));
        }, id, name, bytes)
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
    stream(Buffer.alloc(16 * 16 * 3, 95), "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("q 80 0 0 80 40 40 cm /Art Do Q\nBT /F1 12 Tf 40 24 Td (Figure 1 Harbor Lantern) Tj ET"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 520] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>",
    stream("BT /F1 12 Tf 40 24 Td (Interlude) Tj ET")
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
