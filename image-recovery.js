(() => {
  const byId = (id) => document.getElementById(id);
  const uniqueFileName = window.bookArchive.uniquePngName;
  const dialog = byId("imageRecovery");
  const openButton = byId("openImageRecovery");
  const status = byId("recoveryStatus");
  const confidence = byId("recoveryConfidence");
  const setup = byId("recoverySetup");
  const pageNumber = byId("recoveryPageNumber");
  const candidates = byId("recoveryCandidates");
  const form = byId("recoveryForm");
  const chosenImage = byId("recoveryChosenImage");
  const fileNameInput = byId("recoveryFileName");
  const previewButton = byId("viewRecoveredPreview");
  const skipped = new Set();
  let result;
  let scan;
  let selection;
  let draft;
  let pageIndex;
  let reviewIndex = 0;
  let naming;
  let lastApplied;

  window.imageRecovery = {
    openReview,
    invalidate() { result = null; },
    setPdfAttached(attached) {
      openButton.hidden = !attached;
      if (!attached) reset();
    }
  };

  openButton.addEventListener("click", openReview);
  setup.addEventListener("submit", (event) => {
    event.preventDefault();
    naming = new FormData(setup).get("recoveryNaming");
    showSetup(false);
    scanBook();
  });
  byId("scanImageLinks").addEventListener("click", scanBook);
  byId("cancelImageScan").addEventListener("click", () => scan?.abort());
  byId("previousRecovery").addEventListener("click", () => reviewSlot(reviewIndex - 1));
  byId("nextRecovery").addEventListener("click", () => reviewSlot(reviewIndex + 1));
  byId("nextRecoveryPage").addEventListener("click", () => {
    const page = nextSourcePage(sourcePage(selection.slot));
    reviewSlot(result.slots.findIndex((slot) => sourcePage(slot) === page));
  });
  pageNumber.addEventListener("input", () => pageNumber.setCustomValidity(""));
  byId("jumpRecoveryPage").addEventListener("submit", (event) => {
    event.preventDefault();
    const index = result.slots.findIndex((slot) => sourcePage(slot) === pageNumber.valueAsNumber);
    if (index === -1) {
      pageNumber.setCustomValidity(`No images to review on this ${result.hasPages ? "Markdown page" : "entry"}.`);
      pageNumber.reportValidity();
    } else reviewSlot(index);
  });
  previewButton.addEventListener("click", () => {
    if (!lastApplied) return;
    dialog.close();
    showRecoveredImage(lastApplied);
  });
  byId("skipRecovery").addEventListener("click", () => {
    skipped.add(selection.slot.key);
    renderResults(nextReviewIndex());
  });
  byId("restoreRecovery").addEventListener("click", () => {
    if (lastApplied?.key === selection.slot.key) {
      lastApplied = null;
      previewButton.hidden = true;
    }
    updateImageRecovery(selection.slot, null);
    renderResults(reviewIndex);
    status.textContent = "Restored the original link in the preview.";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!draft || !selection) return;
    const { slot } = selection;
    const fileName = uniqueFileName(fileNameInput.value, takenFileNames(slot.key));
    if (!fileName) {
      status.textContent = "Enter a filename with at least one letter or number.";
      fileNameInput.focus();
      return;
    }
    const caption = byId("recoveryCaption").value.trim();
    updateImageRecovery(slot, { blob: draft.blob, caption, fileName, page: draft.page, label: draft.label });
    lastApplied = slot;
    previewButton.hidden = false;
    skipped.delete(slot.key);
    renderResults(nextReviewIndex());
    status.textContent = `Applied ${fileName} in ${slot.entryTitle}.`;
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    scan?.abort();
    stopSelection();
    window.bookmakerPdf.endRecovery();
  });

  function reset() {
    scan?.abort();
    scan = null;
    stopSelection();
    result = null;
    pageIndex = null;
    reviewIndex = 0;
    naming = null;
    lastApplied = null;
    previewButton.hidden = true;
    setup.reset();
    skipped.clear();
    byId("scanImageLinks").disabled = false;
    byId("cancelImageScan").hidden = true;
    candidates.replaceChildren();
    if (dialog.open) dialog.close();
  }

  function openReview() {
    showSetup(!naming);
    if (!dialog.open) dialog.showModal();
    if (!naming) return;
    if (result?.source !== state.source) scanBook();
    else if (result.slots.length) reviewSlot(reviewIndex);
    else result.pdf.show();
  }

  function showSetup(show) {
    setup.hidden = !show;
    byId("recoveryActions").hidden = show;
    byId("recoveryLayout").hidden = show;
  }

  async function scanBook() {
    scan?.abort();
    stopSelection();
    const pdf = window.bookmakerPdf.getRecoverySource();
    if (!pdf) return;
    pdf.show();
    const job = new AbortController();
    scan = job;
    const { signal } = job;
    const preferred = result?.slots[reviewIndex]?.key;
    result = null;
    byId("recoveryReview").hidden = true;
    byId("scanImageLinks").disabled = true;
    byId("cancelImageScan").hidden = false;

    try {
      const slots = state.imageSlots;
      status.textContent = "Checking which image links load…";
      const urls = [...new Set(slots.map((slot) => slot.url))];
      const links = await checkImageLinks(urls, signal, (done) => {
        status.textContent = `Checking image links (${done}/${urls.length})…`;
      });
      const needsReview = slots.filter((slot) => links.get(slot.url) !== "working" || state.recoveredImages.has(slot.key));
      const pages = pageIndex || [];
      if (needsReview.length && !pageIndex) {
        for (let page = 1; page <= pdf.pages; page += 1) {
          signal.throwIfAborted();
          status.textContent = `Reading PDF text (page ${page} of ${pdf.pages})…`;
          let text;
          try { text = await pdf.text(page, signal); } catch { signal.throwIfAborted(); }
          pages.push(indexPdfText(page, text));
        }
        signal.throwIfAborted();
        pageIndex = pages;
      }
      signal.throwIfAborted();
      const altCounts = new Map();
      for (const slot of slots) {
        const alt = normalizeText(slot.alt);
        altCounts.set(alt, (altCounts.get(alt) || 0) + 1);
      }
      result = {
        pdf, pages, altCounts, slots: needsReview, source: state.source,
        hasPages: slots.some((slot) => slot.page !== null),
        working: slots.filter((slot) => links.get(slot.url) === "working").length,
        broken: slots.filter((slot) => links.get(slot.url) === "broken").length,
        unverified: slots.filter((slot) => links.get(slot.url) === "unverified").length,
        imagePages: new Map()
      };
      renderResults(Math.max(0, needsReview.findIndex((slot) => slot.key === preferred)));
    } catch (error) {
      if (scan === job) status.textContent = signal.aborted ? "Scan canceled. Check image links again to restart." : `Could not check images. ${error.message}`;
    } finally {
      if (scan === job) {
        scan = null;
        byId("scanImageLinks").disabled = false;
        byId("cancelImageScan").hidden = true;
      }
    }
  }

  async function checkImageLinks(urls, signal, onProgress) {
    const links = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
      while (next < urls.length) {
        signal.throwIfAborted();
        const url = urls[next++];
        const outcome = await checkImageLink(url, signal);
        signal.throwIfAborted();
        links.set(url, outcome);
        onProgress(links.size);
      }
    }));
    return links;
  }

  function checkImageLink(url, signal) {
    return new Promise((resolve) => {
      let source;
      try { source = new URL(url, document.baseURI); } catch { return resolve("broken"); }
      if (!["https:", "http:", "data:", "file:", "blob:"].includes(source.protocol)) return resolve("broken");
      const image = new Image();
      const cancel = () => finish("unverified");
      const timer = setTimeout(cancel, 8000);
      function finish(outcome) {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        image.onload = image.onerror = null;
        if (outcome === "unverified") image.removeAttribute("src");
        resolve(outcome);
      }
      signal.addEventListener("abort", cancel, { once: true });
      image.onload = () => finish("working");
      image.onerror = () => finish("broken");
      image.src = source.href;
    });
  }

  function renderResults(preferred) {
    const { slots, broken, working, unverified } = result;
    const summary = `${broken} broken · ${working} working`;
    status.textContent = unverified ? `${summary} · ${unverified} timed out and can be reviewed.` : summary;
    byId("recoveryReview").hidden = !slots.length;
    const taken = takenFileNames();
    result.fileNames = new Map(slots.map((slot, index) => {
      const existing = state.recoveredImages.get(slot.key);
      if (existing) return [slot.key, existing.fileName];
      const fileName = [slot[naming], slot.h2, `image-${index + 1}`]
        .map((title) => uniqueFileName(title || "", taken)).find(Boolean);
      taken.add(fileName);
      return [slot.key, fileName];
    }));
    if (slots.length) reviewSlot(preferred);
  }

  function sourcePage(slot) {
    return result.hasPages ? slot.page : slot.entryIndex + 1;
  }

  function nextSourcePage(current) {
    return Math.min(...result.slots.map(sourcePage).filter((page) => page > current));
  }

  function nextReviewIndex() {
    const { slots } = result;
    for (let offset = 1; offset < slots.length; offset += 1) {
      const index = (reviewIndex + offset) % slots.length;
      const { key } = slots[index];
      if (!skipped.has(key) && !state.recoveredImages.has(key)) return index;
    }
    return reviewIndex;
  }

  function stopSelection() {
    selection?.controller.abort();
    selection = null;
    clearDraft();
  }

  function clearDraft() {
    if (draft) URL.revokeObjectURL(draft.url);
    draft = null;
    chosenImage.removeAttribute("src");
    chosenImage.hidden = true;
    byId("applyRecovery").disabled = true;
  }

  async function reviewSlot(index) {
    const slot = result?.slots[index];
    if (!slot) return;
    reviewIndex = index;
    stopSelection();
    const current = { slot, controller: new AbortController() };
    selection = current;
    const { signal } = current.controller;
    const applied = state.recoveredImages.get(slot.key);
    result.pdf.show((image) => {
      if (selection !== current) return;
      current.request = {};
      showDraft(image);
    }, () => { current.browsed = true; });
    const position = sourcePage(slot);
    const location = result.hasPages && position ? `Markdown page ${position}` : `Entry ${slot.entryIndex + 1}`;
    const tag = applied ? " · Applied" : skipped.has(slot.key) ? " · Skipped" : "";
    byId("recoveryPosition").textContent = `Image ${index + 1} of ${result.slots.length} · ${location}${tag}`;
    byId("previousRecovery").disabled = index === 0;
    byId("nextRecovery").disabled = index === result.slots.length - 1;
    byId("nextRecoveryPage").disabled = !Number.isFinite(nextSourcePage(position));
    byId("nextRecoveryPage").textContent = result.hasPages ? "Next Markdown page" : "Next entry";
    pageNumber.value = position ?? "";
    pageNumber.setCustomValidity("");
    byId("recoveryPageLabel").textContent = result.hasPages ? "Markdown page" : "Entry number";
    const context = [slot.entryTitle, slot.heading, slot.caption || slot.before || slot.after].filter(Boolean);
    byId("recoveryContext").textContent = [...new Set(context)].join(" · ");
    byId("restoreRecovery").hidden = !applied;
    byId("skipRecovery").disabled = Boolean(applied);
    fileNameInput.value = result.fileNames.get(slot.key);
    byId("recoveryCaption").value = applied?.caption ?? (slot.alt || slot.caption);
    form.hidden = false;
    if (applied) showDraft(applied);
    candidates.replaceChildren();
    confidence.textContent = "Looking for nearby PDF images…";

    const anchors = imageAnchors(slot, result.altCounts.get(normalizeText(slot.alt)) === 1);
    const ranked = rankPages(result.pages, anchors, slot.page);
    result.pdf.focus(applied?.page || ranked[0]?.page.number || slot.page || 1);
    const found = [];
    try {
      for (const { page, score } of ranked.slice(0, 3)) {
        signal.throwIfAborted();
        if (!result.imagePages.has(page.number)) {
          const previews = await result.pdf.images(page.number, signal).catch(() => []);
          signal.throwIfAborted();
          result.imagePages.set(page.number, previews);
        }
        for (const image of result.imagePages.get(page.number)) {
          found.push({ ...image, page: page.number, score: score + scoreImage(page, image, anchors) });
        }
      }
      if (selection !== current) return;
      found.sort((left, right) => right.score - left.score || left.page - right.page || left.index - right.index);
      renderCandidates(current, found.slice(0, 8));
    } catch (error) {
      if (selection === current && !signal.aborted) confidence.textContent = `Could not suggest images. ${error.message}`;
    }
  }

  function renderCandidates(current, matches) {
    const [first, second] = matches;
    if (!first) {
      confidence.textContent = "No embedded images found on the suggested pages. Use Select crop in the PDF pane.";
      return;
    }
    const ambiguous = first.score < 5 || (second && first.score - second.score < 2);
    const applied = state.recoveredImages.has(current.slot.key);
    if (!current.request && !current.browsed && !applied) result.pdf.focus(first.page, first.bounds);
    confidence.textContent = ambiguous
      ? "Several matches are possible or the text evidence is weak. Compare the images before choosing."
      : "Review the highlighted match against the PDF.";
    candidates.replaceChildren(...matches.map((match) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      const thumb = document.createElement("img");
      thumb.src = match.thumbnail;
      thumb.alt = "";
      button.append(thumb, `Page ${match.page} · Image ${match.index}`);
      button.addEventListener("click", () => chooseSuggestion(current, match, button));
      item.append(button);
      return item;
    }));
    if (!ambiguous && !applied && !current.request && !current.browsed) chooseSuggestion(current, first, candidates.querySelector("button"));
  }

  async function chooseSuggestion(current, match, button) {
    const request = {};
    current.request = request;
    result.pdf.focus(match.page, match.bounds);
    for (const choice of candidates.querySelectorAll("button")) choice.setAttribute("aria-pressed", String(choice === button));
    button.disabled = true;
    try {
      const blob = await result.pdf.extract(match.page, match.index, current.controller.signal);
      if (selection === current && current.request === request) {
        showDraft({ blob, page: match.page, label: `image-${match.index}` });
      }
    } catch (error) {
      if (selection === current && current.request === request) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function showDraft(image) {
    clearDraft();
    draft = { ...image, url: URL.createObjectURL(image.blob) };
    chosenImage.src = draft.url;
    chosenImage.hidden = false;
    byId("applyRecovery").disabled = false;
  }

  function takenFileNames(except) {
    const taken = new Set([...state.recoveredImages].filter(([id]) => id !== except).map(([, image]) => image.fileName.toLowerCase()));
    for (const path of window.bookArchive.reservedImagePaths(state.bookPackage.assets)) taken.add(path.slice("images/".length));
    return taken;
  }


  function normalizeText(value) {
    return value.normalize("NFKC").toLowerCase().replace(/[\u064A\u0649]/gu, "ی").replace(/\u0643/gu, "ک")
      .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function textIndex(value) {
    const text = normalizeText(value);
    return { text: ` ${text} `, words: new Set(text.split(" ")) };
  }

  function imageAnchors(slot, uniqueAlt) {
    const ignored = new Set("figure caption illustration artwork picture image photo portrait the and for from with into that this was were are have has".split(" "));
    const anchors = [];
    const seen = new Set();
    for (const [value, weight] of [
      [slot.caption, 6], [uniqueAlt ? slot.alt : "", 2], [slot.heading, 3], [slot.before, 2], [slot.after, 2]
    ]) {
      const phrase = normalizeText(value);
      if (!phrase || seen.has(phrase)) continue;
      seen.add(phrase);
      const words = [...new Set(phrase.split(" ").filter((word) => word.length >= 3 && !ignored.has(word) && !/^\p{N}+$/u.test(word)))];
      if (words.length) anchors.push({ phrase: ` ${phrase} `, words, weight });
    }
    return anchors;
  }

  function scoreText(text, anchors) {
    return anchors.reduce((sum, { phrase, words, weight }) => {
      if (text.text.includes(phrase)) return sum + weight;
      const matches = words.filter((word) => text.words.has(word)).length;
      return sum + weight * 0.65 * (matches / words.length) ** 2;
    }, 0);
  }

  function indexPdfText(number, content) {
    const lines = [];
    for (const item of content?.items || []) {
      const [a, b, , , x, y] = item.transform;
      const width = Math.abs(item.width || 0);
      const height = Math.max(2, Math.abs(item.height || 0));
      const endX = x + Math.sign(a || 1) * width;
      const endY = y + (Math.abs(b) > Math.abs(a) ? Math.sign(b) * width : 0);
      const bounds = [Math.min(x, endX), Math.min(y, endY), Math.max(x, endX), Math.max(y, endY) + height];
      const last = lines.at(-1);
      const gap = last && Math.max(0, bounds[0] - last.bounds[2], last.bounds[0] - bounds[2]);
      if (last && !last.endsLine && Math.abs(last.bounds[1] - bounds[1]) < height * 0.4 && gap < height * 1.5) {
        last.text += ` ${item.str}`;
        last.bounds = [Math.min(last.bounds[0], bounds[0]), Math.min(last.bounds[1], bounds[1]),
          Math.max(last.bounds[2], bounds[2]), Math.max(last.bounds[3], bounds[3])];
        last.endsLine = item.hasEOL;
      } else lines.push({ text: item.str, bounds, endsLine: item.hasEOL });
    }
    const [left, bottom, right, top] = content?.view || [0, 0, 612, 792];
    return {
      number, area: (right - left) * (top - bottom), index: textIndex(lines.map((line) => line.text).join(" ")),
      lines: lines.map((line) => ({ text: line.text, bounds: line.bounds, index: textIndex(line.text) }))
    };
  }

  function rankPages(pages, anchors, hint) {
    return pages.map((page) => ({
      page, score: scoreText(page.index, anchors) + (hint ? 1.5 / (1 + Math.abs(hint - page.number)) : 0)
    })).sort((left, right) => right.score - left.score || left.page.number - right.page.number);
  }

  function scoreImage(page, image, anchors) {
    const [left, bottom, right, top] = image.bounds;
    let nearby = 0;
    for (const line of page.lines) {
      const [x1, y1, x2, y2] = line.bounds;
      const horizontal = Math.max(0, left - x2, x1 - right);
      const vertical = Math.max(0, bottom - y2, y1 - top);
      const distance = Math.hypot(horizontal * 2, vertical);
      nearby = Math.max(nearby, scoreText(line.index, anchors) / (1 + distance / 40));
    }
    const area = (right - left) * (top - bottom);
    const penalty = area / page.area > 0.55 ? 6 : area < 256 ? 3 : 0;
    return 2 * nearby - penalty;
  }

})();
