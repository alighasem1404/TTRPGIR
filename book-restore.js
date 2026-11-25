// Restore source images by adding blocks to the current package, never by
// replacing its text or rebuilding its entries from the reference Markdown.
let restoreDraft;
let restoreRequest = 0;

function restoreTextKey(value) {
  return stripMarkup(normalizeBreaks(value ?? "")).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function restoreUrlKey(value) {
  const text = String(value ?? "").trim();
  try { return new URL(text).href; } catch { return text; }
}

function restoreAnchorKey(block) {
  const link = block.type === "link" ? block : block.type === "paragraph" ? parseStandaloneBookLink(block.text) : null;
  if (link) return `link:${restoreTextKey(link.text)}:${restoreUrlKey(link.url)}`;
  if (block.type === "heading") return `h${block.level}:${restoreTextKey(block.text)}`;
  if (block.type === "paragraph") return `p:${restoreTextKey(block.text)}`;
  if (block.type === "list") return `list:${JSON.stringify(block.items.map(restoreTextKey))}`;
  if (block.type === "table") return `table:${JSON.stringify([block.columns, ...block.rows].map((row) => row.map(restoreTextKey)))}`;
  if (block.type === "embed" && block.title) return `embed:${restoreTextKey(block.title)}`;
  return "";
}

function indexRestoreBook(book, level) {
  const anchors = new Map();
  const ids = new Map();
  const titles = new Map();
  const assets = new Map(book.assets.map((asset) => [asset.id, asset]));
  const images = [];
  const urls = new Map();
  for (const [entryIndex, entry] of book.entries.entries()) {
    ids.set(entry.id, entryIndex);
    const names = new Set([entry.title, ...entry.blocks.filter((block) => !block.statBlock && block.type === "heading" && block.level === level).map((block) => block.text)].map(restoreTextKey));
    for (const name of names) {
      if (!name) continue;
      if (!titles.has(name)) titles.set(name, []);
      titles.get(name).push(entryIndex);
    }
    for (const [position, block] of entry.blocks.entries()) {
      const anchor = restoreAnchorKey(block);
      if (anchor) {
        if (!anchors.has(anchor)) anchors.set(anchor, []);
        anchors.get(anchor).push({ entryIndex, position });
      }
      if (block.type !== "image") continue;
      const asset = assets.get(block.assetId);
      if (!asset) continue;
      // An image can have a newer URL after replacement. Session metadata may
      // still know the original URL, which is stronger evidence than its caption.
      const keys = new Set([asset.src, block[markdownImage]?.url, block[imageSlotContext]?.url].map(restoreUrlKey).filter(Boolean));
      const item = { entryIndex, position, block, asset, keys };
      images.push(item);
      for (const key of keys) {
        if (!urls.has(key)) urls.set(key, []);
        urls.get(key).push(item);
      }
    }
  }
  return { anchors, ids, titles, images, urls };
}

function nearestRestoreAnchor(blocks, at, step, index, entryIndex) {
  for (let position = at + step; position >= 0 && position < blocks.length && Math.abs(at - position) <= 24; position += step) {
    const key = restoreAnchorKey(blocks[position]);
    if (!key) continue;
    // Generic headings such as "Backstory" can recur across unrelated
    // chapters. Cross-entry matching needs a unique reference anchor too.
    if (entryIndex === undefined && index.referenceAnchorCounts.get(key) !== 1) continue;
    const all = index.anchors.get(key) || [];
    const matching = entryIndex === undefined ? all : all.filter((item) => item.entryIndex === entryIndex);
    if (matching.length === 1) return { ...matching[0], distance: Math.abs(at - position) };
  }
  return null;
}

function suggestRestorePlacement(candidate, book, index) {
  const { sourceEntry, sourceEntryIndex, sourcePosition } = candidate;
  const titleKey = restoreTextKey(sourceEntry.title);
  const titleMatches = index.titles.get(titleKey) || [];
  const entryMatch = index.ids.get(sourceEntry.id) ?? (titleMatches.length === 1 && index.referenceTitleCounts.get(titleKey) === 1 ? titleMatches[0] : undefined);
  const blocks = sourceEntry.blocks;
  const anchor = (step, entryIndex) => nearestRestoreAnchor(blocks, sourcePosition, step, index, entryIndex);
  const globalBefore = anchor(-1);
  const globalAfter = anchor(1);
  const localBefore = entryMatch === undefined ? null : anchor(-1, entryMatch);
  const localAfter = entryMatch === undefined ? null : anchor(1, entryMatch);

  function fromAnchors(before, after, confidence, reason) {
    const entryIndex = (after || before).entryIndex;
    const count = book.entries[entryIndex].blocks.length;
    const position = after ? after.position : before.position + 1;
    return { entryIndex, position, confidence, reason, entryMatch,
      lower: before ? before.position + 1 : sourcePosition === 0 ? 0 : Math.max(0, position - 2),
      upper: after ? after.position : sourcePosition === blocks.length - 1 ? count : Math.min(count, position + 2) };
  }
  const orderedPair = (before, after) => before && after && before.entryIndex === after.entryIndex && before.position < after.position;
  if (orderedPair(globalBefore, globalAfter)) return fromAnchors(globalBefore, globalAfter, true, "Matching content on both sides.");
  if (orderedPair(localBefore, localAfter)) return fromAnchors(localBefore, localAfter, true, "Matching content in the original entry.");
  if (localBefore && localAfter) return fromAnchors(null, localAfter, false, "Nearby content was reordered; review the position.");
  if (localBefore || localAfter) return fromAnchors(localBefore, localAfter, true, "Matched entry and nearby content.");
  if (globalBefore && globalAfter) return fromAnchors(null, globalAfter, false, "Nearby content is in different locations; review the position.");
  if (globalBefore || globalAfter) return fromAnchors(globalBefore, globalAfter, false, "One nearby source block matched, but the entry could not be confirmed. Review placement.");
  if (entryMatch !== undefined) {
    const count = book.entries[entryMatch].blocks.length;
    const position = sourcePosition === 0 ? 0 : count;
    return { entryIndex: entryMatch, position, confidence: false, reason: "Entry matched, but the original position could not be confirmed.", entryMatch, lower: position, upper: position };
  }
  if (sourceEntryIndex === 0 && sourcePosition === 0 && book.entries.length) {
    return { entryIndex: 0, position: 0, confidence: false, reason: "Possible cover artwork; review the beginning of the book.", lower: 0, upper: 0 };
  }
  return { confidence: false, reason: "No reliable placement match. Choose an entry and position." };
}

function restoreConversionConfig(config) {
  const standard = standardConversionConfig();
  return { ...standard, ...config, overrides: config.overrides || config.images || standard.overrides, rules: { ...standard.rules, ...config.rules,
    entryHeadingLevel: entryHeadingLevel(config), images: { ...standard.rules.images, ...config.rules?.images } } };
}

function scanRestoreImages(book, markdown, fileName, config = {}) {
  const profile = restoreConversionConfig(config);
  const reference = buildBookPackage(markdown, fileName, parseDocument(markdown, profile), profile);
  const assets = new Map(reference.assets.map((asset) => [asset.id, asset]));
  const contexts = markdownImageContexts(markdown, profile);
  const occurrences = new Map();
  const index = indexRestoreBook(book, entryHeadingLevel(profile));
  index.referenceAnchorCounts = new Map();
  index.referenceTitleCounts = new Map();
  for (const entry of reference.entries) {
    const title = restoreTextKey(entry.title);
    index.referenceTitleCounts.set(title, (index.referenceTitleCounts.get(title) || 0) + 1);
    for (const block of entry.blocks) {
      const key = restoreAnchorKey(block);
      if (key) index.referenceAnchorCounts.set(key, (index.referenceAnchorCounts.get(key) || 0) + 1);
    }
  }
  const sourceImages = [];
  for (const [sourceEntryIndex, sourceEntry] of reference.entries.entries()) {
    for (const [sourcePosition, block] of sourceEntry.blocks.entries()) {
      if (block.type !== "image") continue;
      const image = block[markdownImage];
      const asset = assets.get(block.assetId);
      if (!image || !asset) continue;
      const pair = JSON.stringify([image.alt, image.url]);
      const occurrence = occurrences.get(pair) || 0;
      occurrences.set(pair, occurrence + 1);
      const candidate = { ordinal: sourceImages.length, sourceEntry, sourceEntryIndex, sourcePosition, block, image, asset,
        context: contexts.get(pair)?.[occurrence] || { page: null, heading: sourceEntry.title, before: "", after: "", caption: "" },
        urlKey: restoreUrlKey(image.url), possible: "" };
      candidate.suggestion = suggestRestorePlacement(candidate, book, index);
      sourceImages.push(candidate);
    }
  }

  // Match occurrences rather than just assets: the same source URL can be used
  // in several chapters, and one existing image must not satisfy them all.
  const groups = new Map();
  for (const candidate of sourceImages) {
    if (!groups.has(candidate.urlKey)) groups.set(candidate.urlKey, []);
    groups.get(candidate.urlKey).push(candidate);
  }
  const matched = new Set();
  const used = new Set();
  const match = (candidate, record) => { matched.add(candidate); used.add(record); };
  for (const [key, group] of groups) {
    const records = index.urls.get(key) || [];
    const pairs = group.flatMap((candidate) => records.filter((record) => record.entryIndex === candidate.suggestion.entryIndex)
      .map((record) => ({ candidate, record, distance: Math.abs(record.position - candidate.suggestion.position) })));
    const ties = new Map();
    for (const pair of pairs) {
      if (!ties.has(pair.record)) ties.set(pair.record, new Map());
      const distances = ties.get(pair.record);
      distances.set(pair.distance, (distances.get(pair.distance) || 0) + 1);
    }
    pairs.sort((a, b) => a.distance - b.distance || a.candidate.ordinal - b.candidate.ordinal);
    for (const pair of pairs) {
      if (matched.has(pair.candidate) || used.has(pair.record)) continue;
      // Equal-distance repeated occurrences cannot be identified reliably.
      if (ties.get(pair.record).get(pair.distance) > 1) continue;
      match(pair.candidate, pair.record);
    }
    const remaining = group.filter((candidate) => !matched.has(candidate));
    const available = records.filter((record) => !used.has(record));
    if (available.length >= remaining.length) remaining.forEach((candidate, i) => match(candidate, available[i]));
    else if (available.length) remaining.forEach((candidate) => { candidate.possible = "This URL is already in the book; the exact occurrence could not be matched."; });
    else if (records.length) remaining.filter((candidate) => !candidate.suggestion.confidence).forEach((candidate) => {
      candidate.possible = "The same URL is used elsewhere; review this additional occurrence.";
    });
  }
  const candidates = sourceImages.filter((candidate) => !matched.has(candidate));
  for (const candidate of candidates) {
    if (candidate.possible) continue;
    const { suggestion, asset, image } = candidate;
    const alt = restoreTextKey(image.alt);
    const possible = index.images.some((record) => {
      if (used.has(record)) return false;
      const sameEntry = record.entryIndex === suggestion.entryIndex;
      const sameAssetId = record.asset.id === asset.id || record.asset.id.startsWith(`${asset.id}-recovered`);
      const sameLabel = alt && [record.block.alt, record.block.caption, record.asset.alt].some((value) => restoreTextKey(value) === alt);
      const near = sameEntry && record.position >= suggestion.lower && record.position <= suggestion.upper;
      return sameAssetId || sameEntry && sameLabel || near;
    });
    if (possible) candidate.possible = "An existing image may be a replacement or bundled version of this artwork. Review before restoring.";
  }
  return { candidates, sourceCount: sourceImages.length, presentCount: matched.size, sourceTitle: reference.book.title, reference };
}

function restoreBlockLabel(block, book) {
  if (block.type === "link") return `Link: ${block.text}`;
  if (block.type === "heading") return `H${block.level}: ${block.text}`;
  if (block.type === "paragraph") return block.text;
  if (block.type === "image") return `Image: ${block.caption ?? block.alt ?? book.assets.find((asset) => asset.id === block.assetId)?.alt ?? block.assetId}`;
  if (block.type === "list") return `List: ${block.items[0] || ""}`;
  if (block.type === "table") return `Table: ${block.columns.join(" | ")}`;
  return block.title || block.type;
}

function restoreImageName(url) {
  if (/^data:/i.test(url)) return "Embedded image";
  try { return decodeURIComponent(new URL(url, document.baseURI).pathname.split("/").pop() || url); }
  catch { return url.split(/[/?#]/).filter(Boolean).at(-1) || "Image"; }
}

function restorePreviewUrl(url) {
  try {
    const parsed = new URL(url, document.baseURI);
    if (["http:", "https:", "file:"].includes(parsed.protocol) || /^data:image\//i.test(url)) return url;
  } catch { /* An unresolvable relative source can still be restored for later editing. */ }
  return "";
}

function resetBookRestore() {
  restoreRequest += 1;
  restoreDraft = null;
  $("#restoreMarkdownInput").value = "";
  $("#restoreReview").hidden = true;
  $("#restoreRows").replaceChildren();
  $("#restoreStatRows").replaceChildren();
  $("#restoreKind").value = "images";
  $("#applyStatRestore").disabled = true;
  $("#restoreStatus").textContent = "";
  $("#restoreSourceWarning").textContent = "";
  $("#applyRestore").disabled = true;
}

function openBookRestore() {
  if (!state.bookPackage) return;
  resetBookRestore();
  $("#restoreUseSource").hidden = !state.source;
  $("#restoreStatus").textContent = "Choose the original Markdown file to scan for missing images and stat blocks.";
  $("#bookRestore").showModal();
}

async function loadRestoreMarkdown(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !state.bookPackage) return;
  const request = ++restoreRequest;
  const book = state.bookPackage;
  restoreDraft = null;
  $("#restoreReview").hidden = true;
  $("#restoreStatus").textContent = `Reading ${file.name}…`;
  try {
    const markdown = await file.text();
    if (request === restoreRequest && book === state.bookPackage && $("#bookRestore").open) reviewRestoreSource(markdown, file.name);
  } catch (error) {
    if (request === restoreRequest) $("#restoreStatus").textContent = `Could not read the reference Markdown. ${error.message}`;
  }
}

function useLoadedRestoreSource() {
  if (!state.source || !state.bookPackage) return;
  restoreRequest += 1;
  reviewRestoreSource(state.source, state.bookPackage.source?.fileName || "Current Markdown");
}

function reviewRestoreSource(markdown, fileName) {
  restoreDraft = null;
  $("#restoreReview").hidden = true;
  try {
    const book = state.bookPackage;
    const result = scanRestoreImages(book, markdown, fileName, state.config);
    const statResult = scanRestoreStatBlocks(book, markdown, fileName, state.config, result.reference);
    restoreDraft = { book, entries: state.entries, assets: book.assets, recoveries: new Map(state.recoveredImages), result, statResult, rows: [], statRows: [] };
    const expectedName = book.source?.fileName?.split(/[\\/]/).pop();
    const sameTitle = restoreTextKey(book.book.title) === restoreTextKey(result.sourceTitle);
    $("#restoreStatus").textContent = `Scanned ${fileName}. Your open book has not been changed.`;
    $("#restoreSummary").textContent = `${result.sourceCount} source image occurrence(s); ${result.presentCount} already matched; ${result.candidates.length} to review.`;
    $("#restoreSourceWarning").textContent = expectedName && expectedName.toLowerCase() !== fileName.toLowerCase() || !sameTitle && result.sourceTitle !== "Untitled book"
      ? "The reference file name or title differs from the open book. Verify that this is the intended source before restoring." : "";
    $("#restoreRows").replaceChildren(...result.candidates.map((candidate) => makeRestoreRow(candidate, book)));
    if (!result.candidates.length) {
      const empty = document.createElement("li");
      empty.className = "heading-hint";
      empty.textContent = "No missing image occurrences found.";
      $("#restoreRows").append(empty);
    }
    renderStatRestoreReview(statResult, book);
    $("#restoreKind").options[0].textContent = `Missing images (${result.candidates.length})`;
    $("#restoreKind").options[1].textContent = `Stat blocks (${statResult.candidates.length})`;
    $("#restoreKind").value = !result.candidates.length && statResult.candidates.length ? "stats" : "images";
    showRestoreKind();
    $("#restoreReview").hidden = false;
    updateRestoreSelection();
  } catch (error) {
    $("#restoreStatus").textContent = `Could not scan the reference Markdown. ${error.message}`;
  }
}

function showRestoreKind() {
  const stats = $("#restoreKind").value === "stats";
  $("#restoreImageReview").hidden = stats;
  $("#restoreStatReview").hidden = !stats;
}

function makeRestoreRow(candidate, book) {
  const item = document.createElement("li");
  item.className = "restore-row";
  const suggestion = candidate.suggestion;
  const title = candidate.image.alt || restoreImageName(candidate.image.url);
  item.innerHTML = `<div class="restore-art-preview"><span>Preview unavailable</span></div>
    <div class="restore-art-details">
      <label class="restore-choice"><input type="checkbox" data-restore-select> <strong>${escapeHtml(title)}</strong></label>
      <p class="restore-image-name" dir="auto">${escapeHtml(restoreImageName(candidate.image.url))}</p>
      <details><summary>Original image reference</summary><p dir="auto">${escapeHtml(/^data:/i.test(candidate.image.url) ? "Embedded image data" : candidate.image.url)}</p></details>
      <p class="heading-hint">${candidate.context.page ? `Source page ${candidate.context.page} · ` : ""}${escapeHtml(candidate.sourceEntry.title)}${candidate.block.role === "full-page" ? " · Full-page artwork" : ""}</p>
      <p class="restore-match-note${suggestion.confidence && !candidate.possible ? "" : " restore-needs-review"}">${escapeHtml(candidate.possible || suggestion.reason)}</p>
      ${candidate.possible ? `<p class="heading-hint">${escapeHtml(suggestion.reason)}</p>` : ""}
      <label>Destination entry<select data-restore-entry aria-label="Destination entry for ${escapeAttribute(title)}"></select></label>
      <label>Insert position<select data-restore-position aria-label="Insert position for ${escapeAttribute(title)}"></select></label>
    </div>`;
  const preview = restorePreviewUrl(candidate.image.url);
  if (preview) {
    const img = document.createElement("img");
    img.alt = title;
    img.loading = "lazy";
    img.src = preview;
    img.addEventListener("error", () => img.remove(), { once: true });
    item.querySelector(".restore-art-preview").append(img);
  }
  const checkbox = item.querySelector("[data-restore-select]");
  const entrySelect = item.querySelector("[data-restore-entry]");
  const positionSelect = item.querySelector("[data-restore-position]");
  entrySelect.append(new Option("Choose an entry", ""), ...book.entries.map((entry, index) => new Option(`${index + 1}. ${entry.title}`, String(index))));
  entrySelect.value = suggestion.entryIndex === undefined ? "" : String(suggestion.entryIndex);
  function positions(preferred) {
    positionSelect.replaceChildren(new Option("Choose a position", ""));
    if (entrySelect.value === "") { positionSelect.disabled = true; return; }
    positionSelect.disabled = false;
    const entry = book.entries[Number(entrySelect.value)];
    for (const [index, block] of entry.blocks.entries()) {
      const label = restoreBlockLabel(block, book).replace(/\s+/g, " ").slice(0, 90);
      positionSelect.add(new Option(`${index === 0 ? "Beginning — before" : `Before block ${index + 1}:`} ${label}`, String(index)));
    }
    positionSelect.add(new Option(entry.blocks.length ? "End of entry" : "Beginning of empty entry", String(entry.blocks.length)));
    positionSelect.value = preferred === undefined ? "" : String(preferred);
  }
  positions(suggestion.position);
  entrySelect.addEventListener("change", () => { positions(undefined); updateRestoreSelection(); });
  positionSelect.addEventListener("change", updateRestoreSelection);
  checkbox.addEventListener("change", updateRestoreSelection);
  restoreDraft.rows.push({ candidate, checkbox, entrySelect, positionSelect });
  return item;
}

function restoreRowReady(row) {
  return row.entrySelect.value !== "" && row.positionSelect.value !== "";
}

function updateRestoreSelection() {
  const rows = restoreDraft?.rows || [];
  const selected = rows.filter((row) => row.checkbox.checked);
  const incomplete = selected.filter((row) => !restoreRowReady(row)).length;
  $("#restoreSelection").textContent = `${selected.length} selected${incomplete ? `; choose placement for ${incomplete}` : ""}`;
  $("#applyRestore").disabled = !selected.length || Boolean(incomplete);
  $("#restoreClearSelection").disabled = !selected.length;
  $("#restoreSelectSuggested").disabled = !rows.some((row) => !row.checkbox.checked && row.candidate.suggestion.confidence && !row.candidate.possible && restoreRowReady(row));
}

function selectSuggestedRestores() {
  for (const row of restoreDraft?.rows || []) {
    if (row.candidate.suggestion.confidence && !row.candidate.possible && restoreRowReady(row)) row.checkbox.checked = true;
  }
  updateRestoreSelection();
}

function clearRestoreSelection() {
  for (const row of restoreDraft?.rows || []) row.checkbox.checked = false;
  updateRestoreSelection();
}

function buildRestoredBook(book, selections) {
  const assets = new Map(book.assets.map((asset) => [asset.id, asset]));
  const byUrl = new Map(book.assets.map((asset) => [restoreUrlKey(asset.src), asset]));
  const insertions = new Map();
  for (const selection of [...selections].sort((a, b) => a.candidate.ordinal - b.candidate.ordinal)) {
    const { candidate, entryIndex, position } = selection;
    const entry = book.entries[entryIndex];
    if (!entry || !Number.isInteger(position) || position < 0 || position > entry.blocks.length) throw new Error("Choose a valid insertion position for each image.");
    const existing = byUrl.get(candidate.urlKey);
    const assetId = existing?.id || getAssetId(candidate.image.alt, candidate.image.url, assets);
    if (!existing) {
      const added = { ...assets.get(assetId), alt: normalizeBreaks(assets.get(assetId).alt) };
      assets.set(assetId, added);
      byUrl.set(candidate.urlKey, added);
    }
    const block = { ...candidate.block, assetId };
    const beforeGroup = entry.blocks[position - 1]?.statBlock;
    const afterGroup = entry.blocks[position]?.statBlock;
    if (beforeGroup && beforeGroup === afterGroup) block.statBlock = beforeGroup;
    else if (!block.statBlock || block.statBlock !== beforeGroup && block.statBlock !== afterGroup) delete block.statBlock;
    if (existing && existing.alt !== candidate.asset.alt) {
      block.alt = candidate.asset.alt;
      block.caption = candidate.asset.alt;
    }
    block[imageSlotContext] = { ...candidate.image, ...candidate.context, key: `restored-image-${++editedImageId}` };
    if (!insertions.has(entryIndex)) insertions.set(entryIndex, new Map());
    const positions = insertions.get(entryIndex);
    if (!positions.has(position)) positions.set(position, []);
    positions.get(position).push(block);
  }
  const entries = book.entries.map((entry, index) => {
    const positions = insertions.get(index);
    if (!positions) return entry;
    const blocks = [];
    for (let position = 0; position <= entry.blocks.length; position += 1) {
      blocks.push(...(positions.get(position) || []));
      if (position < entry.blocks.length) blocks.push(entry.blocks[position]);
    }
    return { ...entry, blocks };
  });
  return { ...book, entries, assets: [...assets.values()] };
}

function restoreDraftChanged(draft) {
  const recoveriesChanged = draft.recoveries.size !== state.recoveredImages.size ||
    [...draft.recoveries].some(([key, recovery]) => state.recoveredImages.get(key) !== recovery);
  return draft.book !== state.bookPackage || draft.entries !== state.entries || draft.assets !== state.bookPackage.assets || recoveriesChanged;
}

function applyBookRestore() {
  const draft = restoreDraft;
  if (!draft) return;
  const selected = draft.rows.filter((row) => row.checkbox.checked);
  if (!selected.length || selected.some((row) => !restoreRowReady(row))) return;
  if (restoreDraftChanged(draft)) {
    $("#restoreStatus").textContent = "The book changed during review. Scan the original Markdown again.";
    $("#restoreReview").hidden = true;
    restoreDraft = null;
    return;
  }
  try {
    const restored = buildRestoredBook(draft.book, selected.map((row) => ({ candidate: row.candidate,
      entryIndex: Number(row.entrySelect.value), position: Number(row.positionSelect.value) })));
    validateBookPackage(restored);
    state.bookPackage = restored;
    applyEditedEntries(restored.entries, { keepHeadingHistory: false, preserveExistingData: true });
    $("#bookRestore").close();
    showNotice(`Restored ${selected.length} image${selected.length === 1 ? "" : "s"}. Existing content was kept. Export the updated book to save it.`);
  } catch (error) {
    $("#restoreStatus").textContent = `Could not restore the selected images. ${error.message}`;
  }
}
