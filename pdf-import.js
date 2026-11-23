(() => {
  const script = document.currentScript;
  const distribution = new URL(script.dataset.pdfEngine, script.src).href;
  const build = distribution + "legacy/build/";
  const { encodeWebp } = window.bookArchive;
  const byId = (id) => document.getElementById(id);
  const dialog = byId("pdfInspector");
  const canvas = byId("pdfPageCanvas");
  const picker = byId("pdfInput");
  const attachmentStatus = byId("pdfAttachmentStatus");
  const pageStatus = byId("pdfPageStatus");
  const pageNumber = byId("pdfPageNumber");
  const images = byId("pdfImages");
  const cropButton = byId("pdfCrop");
  const saveCropButton = byId("pdfSaveCrop");
  const useCropButton = byId("pdfUseCrop");
  const outline = byId("pdfCropOutline");
  const pane = byId("pdfReviewPane");
  const highlight = byId("pdfImageHighlight");
  let attachment;
  let crop;
  let drag;
  let replacementPicker;
  let pageNavigation;

  window.bookmakerPdf = {
    setBookAvailable(available) {
      detachPdf();
      byId("attachPdf").disabled = !available;
    },
    getRecoverySource,
    endRecovery
  };

  byId("attachPdf").addEventListener("click", () => picker.click());
  byId("removePdf").addEventListener("click", detachPdf);
  byId("reviewPdf").addEventListener("click", openInspector);
  picker.addEventListener("change", () => {
    const file = picker.files[0];
    picker.value = "";
    if (file) attachPdf(file);
  });
  byId("pdfPrevious").addEventListener("click", () => navigatePage(attachment.page - 1));
  byId("pdfNext").addEventListener("click", () => navigatePage(attachment.page + 1));
  byId("jumpPdfPage").addEventListener("submit", (event) => {
    event.preventDefault();
    navigatePage(pageNumber.valueAsNumber);
  });
  cropButton.addEventListener("click", () => setCropMode(cropButton.getAttribute("aria-pressed") !== "true"));
  saveCropButton.addEventListener("click", saveCrop);
  useCropButton.addEventListener("click", () => {
    const surface = cropCanvas();
    if (surface) chooseReplacement(surface, attachment.page, "crop");
  });
  canvas.addEventListener("pointerdown", beginCrop);
  canvas.addEventListener("pointermove", updateCrop);
  canvas.addEventListener("pointerup", finishCrop);
  canvas.addEventListener("pointercancel", () => setCropMode(false));

  function detachPdf() {
    const previous = attachment;
    attachment = null;
    setReplacementPicker(null);
    window.imageRecovery?.setPdfAttached(false);
    previous?.render?.cancel();
    previous?.task?.destroy().catch(() => {});
    if (dialog.open) dialog.close();
    byId("pdfPageBody").hidden = true;
    canvas.width = canvas.height = 1;
    images.replaceChildren();
    byId("pdfPageText").textContent = "";
    setCropMode(false);
    attachmentStatus.textContent = "";
    byId("attachPdf").textContent = "Attach matching PDF";
    byId("removePdf").hidden = true;
    byId("reviewPdf").hidden = true;
  }

  async function attachPdf(file) {
    detachPdf();
    const current = { page: 1, passwordProtected: false };
    attachment = current;
    attachmentStatus.textContent = `Opening ${file.name}…`;
    byId("removePdf").hidden = false;
    try {
      const pdfjs = await import(build + "pdf.min.mjs").catch(() => {
        throw new Error("The PDF engine could not load. Open Bookmaker from its website or a local web server and try again.");
      });
      if (attachment !== current) return;
      pdfjs.GlobalWorkerOptions.workerSrc = build + "pdf.worker.min.mjs";
      const data = new Uint8Array(await file.arrayBuffer());
      if (attachment !== current) return;
      current.pdfjs = pdfjs;
      current.task = pdfjs.getDocument({
        data,
        cMapUrl: distribution + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: distribution + "standard_fonts/",
        wasmUrl: distribution + "wasm/",
        iccUrl: distribution + "iccs/",
        enableScripting: false,
        isEvalSupported: false
      });
      current.task.onPassword = () => {
        current.passwordProtected = true;
        current.task.destroy().catch(() => {});
      };
      current.document = await current.task.promise;
      if (attachment !== current) return;
      attachmentStatus.textContent = `${file.name} · ${current.document.numPages} pages`;
      byId("attachPdf").textContent = "Replace PDF";
      byId("reviewPdf").hidden = false;
      pageNumber.max = current.document.numPages;
      byId("pdfPageTotal").textContent = `of ${current.document.numPages}`;
      window.imageRecovery?.setPdfAttached(true);
      if (window.imageRecovery) window.imageRecovery.openReview();
      else openInspector();
    } catch (error) {
      if (attachment !== current) return;
      detachPdf();
      attachmentStatus.textContent = current.passwordProtected
        ? "This PDF is password-protected. Choose an unlocked copy."
        : `Could not open ${file.name}. ${error.message}`;
    }
  }

  function openInspector() {
    if (!attachment?.document || dialog.open) return;
    dialog.showModal();
    if (byId("pdfPageBody").hidden) showPage(attachment.page);
  }

  function getRecoverySource() {
    const current = attachment;
    if (!current?.document) return null;
    return {
      pages: current.document.numPages,
      show(onChoose, onNavigate) {
        if (attachment !== current) return;
        const host = byId("recoveryPdfPane");
        if (pane.parentElement !== host) {
          host.append(pane);
          byId("pdfEmbeddedImages").open = false;
        }
        setCropMode(false);
        setReplacementPicker(onChoose);
        pageNavigation = onNavigate;
        if (!current.request) showPage(current.page);
      },
      focus(number, bounds) {
        if (attachment !== current) return;
        current.highlight = bounds ? { number, bounds } : null;
        if (number !== current.page || !current.request) showPage(number);
        else updateHighlight();
      },
      text: (number, signal) => withPdfPage(current, number, signal, async (page) => {
        const text = await page.getTextContent();
        return { items: text.items.filter((item) => item.str?.trim()), view: page.view };
      }),
      images: (number, signal) => withPdfPage(current, number, signal, async (page) => {
        const candidates = await pageImages(page, current.pdfjs);
        signal.throwIfAborted();
        return candidates.flatMap((candidate) => {
          try {
            const surface = imageCanvas(candidate, current.pdfjs.ImageKind);
            return surface ? [{
              index: candidate.index, bounds: candidate.bounds, thumbnail: imageThumbnail(surface)
            }] : [];
          } catch { return []; }
        });
      }),
      extract: (number, index, signal) => withPdfPage(current, number, signal, async (page) => {
        const candidates = await pageImages(page, current.pdfjs);
        signal.throwIfAborted();
        const candidate = candidates.find((image) => image.index === index);
        if (!candidate) throw new Error("The embedded image is unavailable.");
        return encodeWebp(imageCanvas(candidate, current.pdfjs.ImageKind));
      })
    };
  }

  async function withPdfPage(current, number, signal, read) {
    signal.throwIfAborted();
    if (current !== attachment) throw new DOMException("PDF was detached.", "AbortError");
    const page = await current.document.getPage(number);
    try {
      signal.throwIfAborted();
      return await read(page);
    } finally {
      if (current.pageProxy !== page) page.cleanup();
    }
  }

  function setReplacementPicker(picker) {
    replacementPicker = picker;
    pane.toggleAttribute("data-picking", Boolean(picker));
    useCropButton.hidden = !picker;
  }

  function endRecovery() {
    pageNavigation = null;
    setReplacementPicker(null);
    setCropMode(false);
    if (attachment) attachment.highlight = null;
    updateHighlight();
    byId("pdfInspectorHome").append(pane);
    byId("pdfEmbeddedImages").open = true;
  }

  function navigatePage(number) {
    if (!attachment?.document) return;
    pageNavigation?.();
    attachment.highlight = null;
    showPage(number);
  }

  function updateHighlight() {
    const active = attachment?.highlight;
    const viewport = attachment?.viewport;
    highlight.hidden = !active || !viewport || active.number !== attachment.page;
    if (highlight.hidden) return;
    const [minX, minY, maxX, maxY] = active.bounds;
    const [x1, y1] = viewport.convertToViewportPoint(minX, minY);
    const [x2, y2] = viewport.convertToViewportPoint(maxX, maxY);
    const clamp = (value, max) => Math.min(max, Math.max(0, value));
    const left = clamp(Math.min(x1, x2), canvas.width);
    const top = clamp(Math.min(y1, y2), canvas.height);
    highlight.style.left = `${100 * left / canvas.width}%`;
    highlight.style.top = `${100 * top / canvas.height}%`;
    highlight.style.width = `${100 * (clamp(Math.max(x1, x2), canvas.width) - left) / canvas.width}%`;
    highlight.style.height = `${100 * (clamp(Math.max(y1, y2), canvas.height) - top) / canvas.height}%`;
    const host = byId("recoveryPdfPane");
    if (pane.parentElement !== host) return;
    const figure = highlight.getBoundingClientRect();
    const visible = host.getBoundingClientRect();
    if (figure.top < visible.top || figure.bottom > visible.bottom) {
      host.scrollTop += (figure.top + figure.bottom - visible.top - visible.bottom) / 2;
    }
  }

  async function chooseReplacement(surface, page, label, bounds) {
    const picker = replacementPicker;
    try {
      const blob = await encodeWebp(surface);
      if (!picker || replacementPicker !== picker) return;
      picker({ blob, page, label, bounds });
    } catch (error) {
      if (picker && replacementPicker === picker) pageStatus.textContent = error.message;
    }
  }

  async function showPage(requestedPage) {
    const current = attachment;
    if (!current?.document) return;
    const number = Math.max(1, Math.min(current.document.numPages, Math.trunc(requestedPage) || 1));
    const request = {};
    current.request = request;
    current.page = number;
    current.viewport = null;
    updateHighlight();
    const stillCurrent = () => attachment === current && current.request === request;
    current.render?.cancel();
    current.pageProxy?.cleanup();
    current.pageProxy = null;
    pageNumber.value = number;
    byId("pdfPrevious").disabled = number === 1;
    byId("pdfNext").disabled = number === current.document.numPages;
    byId("pdfPageBody").hidden = true;
    images.replaceChildren();
    setCropMode(false);
    pageStatus.textContent = `Loading page ${number}…`;

    try {
      const page = await current.document.getPage(number);
      if (!stillCurrent()) return;
      current.pageProxy = page;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 2200 / Math.max(natural.width, natural.height)) });
      const rendered = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const annotationMode = current.pdfjs.AnnotationMode.DISABLE;
      current.render = page.render({ canvas: rendered, canvasContext: rendered.getContext("2d"), viewport, annotationMode, background: "transparent" });
      const [textResult, imageResult, renderResult] = await Promise.allSettled([
        page.getTextContent(),
        pageImages(page, current.pdfjs),
        current.render.promise
      ]);
      if (!stillCurrent()) return;
      current.render = null;
      if (renderResult.status === "rejected") throw renderResult.reason;

      canvas.width = rendered.width;
      canvas.height = rendered.height;
      byId("pdfPreviewStage").style.setProperty("--pdf-page-ratio", canvas.width / canvas.height);
      canvas.getContext("2d").drawImage(rendered, 0, 0);
      current.viewport = viewport;
      const text = textResult.value?.items.filter((item) => typeof item.str === "string") || [];
      const candidates = imageResult.value || [];
      byId("pdfPageText").textContent = text.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("").trim()
        || "No selectable text on this page.";
      renderImages(candidates, current.pdfjs.ImageKind, number);
      pageStatus.textContent = textResult.status === "rejected" ? "The page rendered, but its text could not be read." : "";
      if (imageResult.status === "rejected") {
        byId("pdfImageSummary").textContent = "Embedded images could not be read. Select a page crop to recover a figure.";
      }
      byId("pdfPageBody").hidden = false;
      updateHighlight();
    } catch (error) {
      if (stillCurrent()) {
        current.request = null;
        pageStatus.textContent = `Could not render page ${number}. ${error.message}`;
      }
    }
  }

  function pageImages(page, pdfjs) {
    return readPdfImages(page, pdfjs.OPS, pdfjs.AnnotationMode.DISABLE);
  }

  async function readPdfImages(page, ops, annotationMode) {
    const { fnArray, argsArray } = await page.getOperatorList({ annotationMode });
    const candidates = [];
    const stack = [];
    let matrix = new DOMMatrix();
    const add = (boundsMatrix, image, reference, slice) => {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => boundsMatrix.transformPoint({ x, y }));
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      candidates.push({ index: candidates.length + 1, image, reference, slice, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    };
    for (const [index, op] of fnArray.entries()) {
      const args = argsArray[index];
      switch (op) {
        case ops.save:
        case ops.beginGroup:
          stack.push(matrix);
          break;
        case ops.paintFormXObjectBegin: {
          stack.push(matrix);
          if (args?.[0]) matrix = matrix.multiply(new DOMMatrix(args[0]));
          break;
        }
        case ops.restore:
        case ops.paintFormXObjectEnd:
        case ops.endGroup:
          matrix = stack.pop() || new DOMMatrix();
          break;
        case ops.transform:
          matrix = matrix.multiply(new DOMMatrix(args));
          break;
        case ops.paintImageXObject:
          add(matrix, null, args[0]);
          break;
        case ops.paintInlineImageXObject:
          add(matrix, args[0]);
          break;
        case ops.paintImageXObjectRepeat: {
          const [id, scaleX, scaleY, positions] = args;
          for (let position = 0; position < positions.length; position += 2) {
            add(matrix.multiply(new DOMMatrix([scaleX, 0, 0, scaleY, positions[position], positions[position + 1]])), null, id);
          }
          break;
        }
        case ops.paintInlineImageXObjectGroup:
          for (const slice of args[1]) {
            add(matrix.multiply(new DOMMatrix(slice.transform)), args[0], null, slice);
          }
          break;
      }
    }
    await resolveImageReferences(page, candidates);
    return candidates.filter(({ image }) => image?.width && image.height);
  }

  async function resolveImageReferences(page, candidates) {
    const references = new Map();
    for (const { reference } of candidates) {
      if (!reference || references.has(reference)) continue;
      const pool = reference.startsWith("g_") ? page.commonObjs : page.objs;
      references.set(reference, pool);
    }
    if (!references.size) return;
    let timer;
    try {
      const ready = [...references].map(([id, pool]) => new Promise((resolve) => pool.get(id, resolve)));
      await Promise.race([Promise.allSettled(ready), new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      for (const candidate of candidates) {
        const pool = references.get(candidate.reference);
        if (pool?.has(candidate.reference)) candidate.image = pool.get(candidate.reference);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function makeCanvas(width, height) {
    const surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    return surface;
  }

  function imageCanvas({ image, slice }, kinds) {
    const { width, height, bitmap, data, kind } = image;
    let source = bitmap;
    if (!source) {
      if (!data) return null;
      source = makeCanvas(width, height);
      const context = source.getContext("2d");
      const pixels = context.createImageData(width, height);
      if (kind === kinds.RGBA_32BPP) pixels.data.set(data);
      else if (kind === kinds.RGB_24BPP) {
        for (let from = 0, to = 0; to < pixels.data.length; from += 3, to += 4) {
          pixels.data[to] = data[from];
          pixels.data[to + 1] = data[from + 1];
          pixels.data[to + 2] = data[from + 2];
          pixels.data[to + 3] = 255;
        }
      } else if (kind === kinds.GRAYSCALE_1BPP) {
        const stride = Math.ceil(width / 8);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const to = (y * width + x) * 4;
            const value = data[y * stride + (x >> 3)] & (0x80 >> (x % 8)) ? 255 : 0;
            pixels.data[to] = pixels.data[to + 1] = pixels.data[to + 2] = value;
            pixels.data[to + 3] = 255;
          }
        }
      } else return null;
      context.putImageData(pixels, 0, 0);
    }
    if (!slice && !bitmap) return source;
    const imageWidth = slice?.w ?? width;
    const imageHeight = slice?.h ?? height;
    const surface = makeCanvas(imageWidth, imageHeight);
    surface.getContext("2d").drawImage(source, slice?.x ?? 0, slice?.y ?? 0, imageWidth, imageHeight, 0, 0, imageWidth, imageHeight);
    return surface;
  }

  function renderImages(candidates, kinds, page) {
    const entries = [];
    for (const candidate of candidates) {
      let source;
      try { source = imageCanvas(candidate, kinds); } catch { continue; }
      if (!source) continue;
      const thumbnail = document.createElement("img");
      const { index } = candidate;
      thumbnail.src = imageThumbnail(source);
      thumbnail.alt = "";
      const button = document.createElement("button");
      button.type = "button";
      button.append(thumbnail, `Download image ${index} (${source.width} × ${source.height})`);
      button.addEventListener("click", () => downloadWebp(imageCanvas(candidate, kinds), `page-${page}-image-${index}.webp`));
      const use = document.createElement("button");
      use.type = "button";
      use.className = "pdf-use-image";
      use.textContent = `Use image ${index} as replacement`;
      use.addEventListener("click", () => {
        attachment.highlight = { number: page, bounds: candidate.bounds };
        updateHighlight();
        chooseReplacement(imageCanvas(candidate, kinds), page, `image-${index}`, candidate.bounds);
      });
      const entry = document.createElement("li");
      entry.append(button, use);
      entries.push(entry);
    }
    images.replaceChildren(...entries);
    byId("pdfImageSummary").textContent = entries.length
      ? `${entries.length} downloadable image${entries.length === 1 ? "" : "s"} on this page.`
      : "No downloadable embedded images on this page. Use Select crop for vector or layered artwork.";
  }

  function imageThumbnail(source) {
    const scale = Math.min(1, 160 / Math.max(source.width, source.height));
    const preview = makeCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
    preview.getContext("2d").drawImage(source, 0, 0, preview.width, preview.height);
    return preview.toDataURL("image/png");
  }

  function setCropMode(active) {
    drag = crop = null;
    cropButton.setAttribute("aria-pressed", String(active));
    canvas.classList.toggle("selecting-crop", active);
    byId("pdfCropHint").hidden = !active;
    outline.hidden = true;
    saveCropButton.disabled = useCropButton.disabled = true;
  }

  function cropPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    };
  }

  function beginCrop(event) {
    if (cropButton.getAttribute("aria-pressed") !== "true" || !event.isPrimary || event.button !== 0) return;
    drag = { pointer: event.pointerId, start: cropPoint(event) };
    canvas.setPointerCapture(event.pointerId);
    updateCrop(event);
  }

  function updateCrop(event) {
    if (event.pointerId !== drag?.pointer) return;
    const point = cropPoint(event);
    const { start } = drag;
    crop = {
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y)
    };
    for (const [property, value] of Object.entries({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })) {
      outline.style[property] = `${value * 100}%`;
    }
    outline.hidden = false;
    saveCropButton.disabled = useCropButton.disabled = true;
  }

  function finishCrop(event) {
    if (event.pointerId !== drag?.pointer) return;
    updateCrop(event);
    drag = null;
    const empty = crop.width * canvas.width < 2 || crop.height * canvas.height < 2;
    saveCropButton.disabled = useCropButton.disabled = outline.hidden = empty;
  }

  function saveCrop() {
    const surface = cropCanvas();
    if (surface) downloadWebp(surface, `page-${attachment.page}-crop.webp`);
  }

  function cropCanvas() {
    if (!crop || !attachment || saveCropButton.disabled) return null;
    const x = Math.floor(crop.x * canvas.width);
    const y = Math.floor(crop.y * canvas.height);
    const width = Math.ceil((crop.x + crop.width) * canvas.width) - x;
    const height = Math.ceil((crop.y + crop.height) * canvas.height) - y;
    const surface = makeCanvas(width, height);
    surface.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, width, height);
    return surface;
  }

  function downloadWebp(surface, fileName) {
    encodeWebp(surface).then((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch((error) => { pageStatus.textContent = error.message; });
  }
})();
