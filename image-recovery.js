(() => {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("imageRecovery");
  const openButton = byId("openImageRecovery");
  const status = byId("recoveryStatus");
  const confidence = byId("recoveryConfidence");
  const list = byId("brokenImageList");
  const candidates = byId("recoveryCandidates");
  const form = byId("recoveryForm");
  const chosenImage = byId("recoveryChosenImage");
  const skipped = new Set();
  let result;
  let scan;
  let selection;
  let draft;

  window.imageRecovery = {
    setPdfAttached(attached) {
      openButton.hidden = !attached;
      if (!attached) reset();
    }
  };

  openButton.addEventListener("click", openReview);
  byId("scanImageLinks").addEventListener("click", scanBook);
  byId("cancelImageScan").addEventListener("click", () => scan?.abort());
  list.addEventListener("change", () => reviewSlot());
  byId("browseRecoveryPdf").addEventListener("click", browsePdf);
  byId("skipRecovery").addEventListener("click", () => {
    skipped.add(list.value);
    renderResults(list.value);
    status.textContent = "Skipped. You can select this image again to review it.";
  });
  byId("restoreRecovery").addEventListener("click", () => {
    updateImageRecovery(selection.slot, null);
    renderResults(list.value);
    status.textContent = "Restored the original link in the preview.";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!draft || !selection) return;
    const { slot } = selection;
    const fileName = uniqueFileName(byId("recoveryFileName").value, slot.key);
    if (!fileName) {
      status.textContent = "Enter a filename with at least one letter or number.";
      byId("recoveryFileName").focus();
      return;
    }
    const caption = byId("recoveryCaption").value.trim();
    updateImageRecovery(slot, { blob: draft.blob, caption, fileName, page: draft.page, label: draft.label });
    skipped.delete(slot.key);
    renderResults(slot.key);
    status.textContent = `Applied ${fileName} in ${slot.entryTitle}.`;
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) scan?.abort();
  });

  function reset() {
    scan?.abort();
    scan = null;
    stopSelection();
    result = null;
    skipped.clear();
    byId("scanImageLinks").disabled = false;
    byId("cancelImageScan").hidden = true;
    list.replaceChildren();
    candidates.replaceChildren();
    if (dialog.open) dialog.close();
  }

  function openReview() {
    dialog.showModal();
    if (result?.source !== state.source) scanBook();
  }

  async function scanBook() {
    scan?.abort();
    stopSelection();
    const pdf = window.bookmakerPdf.getRecoverySource();
    if (!pdf) return;
    const job = new AbortController();
    scan = job;
    const { signal } = job;
    const preferred = list.value;
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
      const needsReview = slots.filter((slot) => links.get(slot.url) === "broken" || state.recoveredImages.has(slot.key));
      const pages = [];
      if (needsReview.length) {
        for (let page = 1; page <= pdf.pages; page += 1) {
          signal.throwIfAborted();
          status.textContent = `Reading PDF text (page ${page} of ${pdf.pages})…`;
          let text;
          try { text = await pdf.text(page, signal); } catch { signal.throwIfAborted(); }
          pages.push(indexPdfText(page, text));
        }
      }
      signal.throwIfAborted();
      result = {
        pdf, pages, slots: needsReview, source: state.source,
        working: slots.filter((slot) => links.get(slot.url) === "working").length,
        broken: slots.filter((slot) => links.get(slot.url) === "broken").length,
        unverified: slots.filter((slot) => links.get(slot.url) === "unverified").length,
        imagePages: new Map()
      };
      renderResults(preferred);
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
    status.textContent = unverified ? `${summary} · ${unverified} timed out. Check links again to retry timeouts.` : summary;
    byId("recoveryReview").hidden = !slots.length;
    list.replaceChildren(...slots.map((slot, index) => {
      const name = slot.alt || slot.caption || `Image ${index + 1}`;
      const location = slot.page ? `Markdown page ${slot.page}` : slot.entryTitle;
      const tag = state.recoveredImages.has(slot.key) ? "Applied · " : skipped.has(slot.key) ? "Skipped · " : "";
      return new Option(`${tag}${index + 1}. ${name} — ${location}`, slot.key);
    }));
    if (slots.some((slot) => slot.key === preferred)) list.value = preferred;
    if (slots.length) reviewSlot();
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
    form.hidden = true;
  }

  async function reviewSlot() {
    stopSelection();
    const slot = result.slots.find((candidate) => candidate.key === list.value);
    if (!slot) return;
    const current = { slot, controller: new AbortController(), page: slot.page || 1 };
    selection = current;
    const { signal } = current.controller;
    const applied = state.recoveredImages.get(slot.key);
    const context = [slot.heading || slot.entryTitle, slot.caption || slot.before || slot.after].filter(Boolean);
    byId("recoveryContext").textContent = context.join(" · ");
    byId("restoreRecovery").hidden = !applied;
    byId("skipRecovery").disabled = Boolean(applied);
    if (applied) showDraft(applied, slot);
    candidates.replaceChildren();
    confidence.textContent = "Looking for nearby PDF images…";

    const anchors = imageAnchors(slot);
    const ranked = rankPages(result.pages, anchors, slot.page);
    if (ranked.length) current.page = ranked[0].page.number;
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
      confidence.textContent = "No embedded images found on the suggested pages. Browse the PDF or select a crop.";
      return;
    }
    current.page = first.page;
    confidence.textContent = first.score < 5 || (second && first.score - second.score < 2)
      ? "Several matches are possible or the text evidence is weak. Compare the images before choosing."
      : "Suggestions are ranked using the surrounding Markdown and nearby PDF text.";
    candidates.replaceChildren(...matches.map((match) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const thumb = document.createElement("img");
      thumb.src = match.thumbnail;
      thumb.alt = "";
      button.append(thumb, `Page ${match.page} · Image ${match.index}`);
      button.addEventListener("click", () => chooseSuggestion(current, match, button));
      item.append(button);
      return item;
    }));
  }

  async function chooseSuggestion(current, match, button) {
    const request = {};
    current.request = request;
    button.disabled = true;
    try {
      const blob = await result.pdf.extract(match.page, match.index, current.controller.signal);
      if (selection === current && current.request === request) {
        showDraft({ blob, page: match.page, label: `image-${match.index}` }, current.slot);
      }
    } catch (error) {
      if (selection === current && current.request === request) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function browsePdf() {
    const current = selection;
    current.request = null;
    dialog.close();
    result.pdf.pick(current.page, (image) => {
      if (selection !== current) return;
      dialog.showModal();
      showDraft(image, current.slot);
    }, () => {
      if (selection === current) dialog.showModal();
    });
  }

  function showDraft(image, slot) {
    clearDraft();
    draft = { ...image, url: URL.createObjectURL(image.blob) };
    const name = suggestedName(slot) || `page-${image.page}-${image.label}`;
    const existing = state.recoveredImages.get(slot.key);
    byId("recoveryFileName").value = image.fileName || existing?.fileName || uniqueFileName(name, slot.key);
    byId("recoveryCaption").value = image.caption ?? existing?.caption ?? (slot.alt || slot.caption);
    chosenImage.src = draft.url;
    form.hidden = false;
  }

  function suggestedName(slot) {
    const generic = /^(?:(?:the )?(?:art(?:work)?|image|illustration|picture|photo|figure|portrait)(?: \d+)?)$/i;
    const name = [slot.alt, slot.caption].find((text) => text && !generic.test(text.trim())) || "";
    return name.replace(/^\s*(?:fig(?:ure)?\.?|caption)\s*(?:\d+\s*)?[:.\-–—]?\s+/i, "");
  }

  function uniqueFileName(value, key) {
    const normalized = value.normalize("NFKC").trim().replace(/\.(?:png|jpe?g|webp|gif|svg|bmp|tiff?)$/i, "")
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "");
    const base = [...normalized].slice(0, 80).join("");
    if (!/[\p{L}\p{N}]/u.test(base)) return "";
    const stem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `image-${base}` : base;
    const taken = new Set([...state.recoveredImages].filter(([id]) => id !== key).map(([, image]) => image.fileName.toLowerCase()));
    for (const path of window.bookArchive.reservedImagePaths(state.bookPackage.assets)) taken.add(path.slice("images/".length));
    let fileName = `${stem}.png`;
    for (let suffix = 2; taken.has(fileName); suffix += 1) fileName = `${stem}-${suffix}.png`;
    return fileName;
  }

  function normalizeText(value) {
    return value.normalize("NFKC").toLowerCase().replace(/[\u064A\u0649]/gu, "ی").replace(/\u0643/gu, "ک")
      .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function textIndex(value) {
    const text = normalizeText(value);
    return { text: ` ${text} `, words: new Set(text.split(" ")) };
  }

  function imageAnchors(slot) {
    const ignored = new Set("figure caption illustration artwork picture image photo portrait the and for from with into that this was were are have has".split(" "));
    const anchors = [];
    const seen = new Set();
    for (const [value, weight] of [
      [slot.caption, 6], [slot.alt, 5], [slot.heading, 3], [slot.before, 2], [slot.after, 2]
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
      lines: lines.map((line) => ({ bounds: line.bounds, index: textIndex(line.text) }))
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
