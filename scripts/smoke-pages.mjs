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
  } finally {
    browser.close();
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
