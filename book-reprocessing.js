// Add new, repeatable package upgrades here as the Maker's conversion rules evolve.
const BOOK_REPROCESS_RULES = [
  { id: "line-breaks", label: "Line breaks", run: reprocessLineBreaks },
  { id: "part-headings", label: "H1 book parts", run: reprocessPartHeadings }
];

let reprocessDraft;

// Copy the package data for a cancellable preview, while retaining Maker-only
// symbol metadata (image slot keys, source anchors, and section visibility).
function copyReprocessData(value) {
  if (Array.isArray(value)) return value.map(copyReprocessData);
  if (value && typeof value === "object") {
    const copy = { ...value };
    for (const key of Object.keys(value)) copy[key] = copyReprocessData(value[key]);
    return copy;
  }
  return value;
}

function planBookReprocessing(book, level, recoveries = new Map()) {
  const plan = {
    book: copyReprocessData(book),
    recoveries: new Map(recoveries),
    level,
    mergedEntries: new Map(),
    results: []
  };
  for (const rule of BOOK_REPROCESS_RULES) {
    plan.results.push({ id: rule.id, label: rule.label, ...rule.run(plan) });
  }
  plan.changed = plan.results.some((result) => result.changed);
  validateBookPackage(plan.book);
  return plan;
}

function reprocessLineBreaks({ book, recoveries }) {
  let fields = 0;
  normalizeBookText(book, () => { fields += 1; });
  for (const [key, recovery] of recoveries) {
    const caption = normalizeBreaks(recovery.caption ?? "");
    if (caption === recovery.caption) continue;
    recoveries.set(key, { ...recovery, caption });
    fields += 1;
  }
  return { changed: fields > 0, message: fields ? `${fields} text field${fields === 1 ? "" : "s"} converted to real line breaks.` : "Already up to date." };
}

function reprocessPartHeadings({ book, level, mergedEntries }) {
  if (level === 1) return { changed: false, message: "Not applicable: this book uses H1 as its entry heading level." };
  const entries = book.entries;
  const isEntryHeading = (block) => block.type === "heading" && block.level === level;
  const isPart = (block) => block.type === "heading" && block.level === 1;
  let headings = 0;
  let blocksMoved = 0;
  // Work backwards so consecutive legacy part-only entries can be folded into
  // the next real entry without changing the original content sequence.
  for (let index = entries.length - 2; index >= 0; index -= 1) {
    const current = entries[index];
    const next = entries[index + 1];
    if (!next.blocks.some(isEntryHeading)) continue;
    const lastEntryHeading = current.blocks.findLastIndex(isEntryHeading);
    const start = current.blocks.findIndex((block, blockIndex) => blockIndex > lastEntryHeading && isPart(block));
    if (start < 0) continue;
    const moved = current.blocks.slice(start);
    headings += moved.filter(isPart).length;
    blocksMoved += moved.length;
    next.blocks = [...moved, ...next.blocks];
    current.blocks = current.blocks.slice(0, start);

    // Source artifacts are session-only. Keep them with their moved heading or
    // converted block so the Homebrewery item editor still finds them.
    if (current[sourceArtifact]?.length) {
      const anchors = new Set(moved.map((block) => block[sourceHeadingKey]).filter(Boolean));
      const artifacts = new Set(moved.map((block) => block[sourceArtifact]).filter(Boolean));
      const belongsToPart = (artifact) => start === 0 || anchors.has(artifact.anchor) || artifacts.has(artifact);
      const moving = current[sourceArtifact].filter(belongsToPart);
      current[sourceArtifact] = current[sourceArtifact].filter((artifact) => !belongsToPart(artifact));
      if (moving.length) next[sourceArtifact] = [...moving, ...(next[sourceArtifact] || [])];
    }
    if (!current.blocks.length) {
      mergedEntries.set(current.id, next.id);
      entries.splice(index, 1);
    }
  }
  if (headings) entries.forEach((entry, order) => { entry.order = order; });
  const merged = mergedEntries.size;
  return {
    changed: headings > 0,
    message: headings ? `Moved ${headings} H1 part heading${headings === 1 ? "" : "s"} (${blocksMoved} content blocks) to the following entry; merged ${merged} redundant part entr${merged === 1 ? "y" : "ies"}.` : "Already up to date."
  };
}

function openBookReprocess() {
  if (!state.bookPackage) return;
  try {
    const plan = planBookReprocessing(state.bookPackage, entryHeadingLevel(state.config), state.recoveredImages);
    reprocessDraft = {
      plan, original: state.bookPackage, entries: state.entries,
      theme: state.bookPackage.theme, assets: state.bookPackage.assets,
      recoveries: new Map(state.recoveredImages)
    };
    const from = state.entries.length;
    const to = plan.book.entries.length;
    $("#reprocessSummary").textContent = plan.changed
      ? `Updates are available. Entries: ${from} → ${to}.`
      : state.normalizedBreakFieldsOnLoad
        ? "This book is up to date. Export it to save the normalized text."
        : "This book already follows all current reprocessing rules.";
    $("#reprocessResults").replaceChildren(...plan.results.map((result) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = result.label;
      const detail = document.createElement("p");
      detail.textContent = result.message;
      if (result.id === "line-breaks" && state.normalizedBreakFieldsOnLoad) {
        detail.textContent += ` ${state.normalizedBreakFieldsOnLoad} text field(s) were already normalized when this book was opened.`;
      }
      item.append(title, detail);
      return item;
    }));
    $("#applyReprocess").disabled = !plan.changed;
    $("#bookReprocess").showModal();
  } catch (error) {
    showNotice(`Could not check this book for updates. ${error.message}`);
  }
}

function applyBookReprocess() {
  const draft = reprocessDraft;
  if (!draft?.plan.changed) return;
  const recoveriesChanged = draft.recoveries.size !== state.recoveredImages.size ||
    [...draft.recoveries].some(([key, recovery]) => state.recoveredImages.get(key) !== recovery);
  if (draft.original !== state.bookPackage || draft.entries !== state.entries ||
      draft.theme !== state.bookPackage.theme || draft.assets !== state.bookPackage.assets || recoveriesChanged) {
    $("#bookReprocess").close();
    showNotice("The book changed while the preview was open. Reprocess it again to review current updates.");
    return;
  }
  const { plan } = draft;
  const currentId = state.entries[state.currentPage]?.id;
  const currentEntryId = plan.mergedEntries.get(currentId) || currentId;
  // Do not reload the file: keep the active PDF, bundled blobs, recovered images,
  // theme, and all preview editing state. Only apply the staged package updates.
  state.bookPackage = plan.book;
  state.recoveredImages = plan.recoveries;
  applyEditedEntries(plan.book.entries, { keepHeadingHistory: false, currentEntryId });
  applyPackageMeta(state.bookPackage);
  $("#bookReprocess").close();
  showNotice("Book reprocessed with the current rules. Export the updated JSON or ZIP to save it.");
}
