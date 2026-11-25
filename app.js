const SOURCE_PATH = encodeURI("Test text/Euphoria Demo.txt");
const CONFIG_PATH = "books/euphoria-demo/conversion.json";
// Internal annotation, added only while converting the source.
const IMAGE_ONLY_PAGE_MARKER = " <!--TTRPGIR_IMAGE_ONLY_PAGE-->";

const state = {
  source: "",
  config: {},
  bookPackage: null,
  entries: [],
  currentPage: 0,
  search: "",
  sourceTheme: null,
  paletteMode: "source",
  headingHistory: [],
  imageSlots: [],
  recoveredImages: new Map(),
  bundledImages: new Map(),
  previewImages: new WeakMap()
};

const $ = (selector) => document.querySelector(selector);
const markdownImage = Symbol("markdownImage");
const imageSlotContext = Symbol("imageSlotContext");
const sourceArtifact = Symbol("sourceArtifact");
const sourceHeadingKey = Symbol("sourceHeadingKey");
const sourceHidden = Symbol("sourceHidden");
const sectionVisibility = Symbol("sectionVisibility");
let editedImageId = 0;
let headingDraft;
let importVersion = 0;
let zipExport;
let bookImport;

document.addEventListener("DOMContentLoaded", () => {
  $("#previousButton").addEventListener("click", () => goToPage(state.currentPage - 1));
  $("#nextButton").addEventListener("click", () => goToPage(state.currentPage + 1));
  $("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderContents();
  });
  $("#mdInput").addEventListener("change", loadSelectedMarkdown);
  $("#jsonInput").addEventListener("change", loadSelectedBook);
  $("#exportButton").addEventListener("click", exportBook);
  $("#downloadBookZip").addEventListener("click", downloadBookZip);
  $("#bookZipExport").addEventListener("close", (event) => {
    if (!event.target.open) zipExport = null;
  });
  $("#reprocessBook").addEventListener("click", openBookReprocess);
  $("#applyReprocess").addEventListener("click", applyBookReprocess);
  $("#bookReprocess").addEventListener("close", (event) => { if (!event.target.open) reprocessDraft = null; });
  $("#openHeadings").addEventListener("click", openHeadingEditor);
  $("#undoHeadings").addEventListener("click", undoHeadingEdit);
  $("#headingSearch").addEventListener("input", filterHeadingRows);
  $("#headingRows").addEventListener("input", updateHeadingControls);
  $("#selectHeadings").addEventListener("change", selectVisibleHeadings);
  $("#updateSelectedHeadings").addEventListener("click", updateSelectedHeadingLevels);
  $("#previewHeadings").addEventListener("click", previewHeadingChanges);
  $("#backToHeadingEdit").addEventListener("click", () => showHeadingPreview(false));
  $("#applyHeadings").addEventListener("click", applyHeadingChanges);
  $("#headingEditor").addEventListener("close", (event) => {
    if (!event.target.open) headingDraft = null;
  });
  $("#themePreset")?.addEventListener("change", applySelectedTheme);
  $("#paletteColorControls")?.addEventListener("input", handlePaletteInput);
  $("#paletteColorControls")?.addEventListener("change", handleInvalidPaletteValue);
  $("#sourceToggle").addEventListener("click", () => {
    const sourceSlice = $("#sourceSlice");
    sourceSlice.hidden = !sourceSlice.hidden;
    $("#sourceToggle").textContent = sourceSlice.hidden ? "Show JSON entry" : "Hide JSON entry";
  });
  loadSource();
});

async function loadSource() {
  const version = ++importVersion;
  try {
    const [sourceResponse, configResponse] = await Promise.all([fetch(SOURCE_PATH, { cache: "no-cache" }), fetch(CONFIG_PATH, { cache: "no-cache" })]);
    if (!sourceResponse.ok || !configResponse.ok) throw new Error("Could not load the demo source or its conversion profile.");
    const [source, config] = await Promise.all([sourceResponse.text(), configResponse.json()]);
    if (version === importVersion) loadDocument(source, "Euphoria Demo.txt", config);
  } catch (error) {
    if (version !== importVersion) return;
    setStatus("Import a Markdown file to begin");
    showNotice("The demo source could not be loaded automatically. Choose the Markdown file with Import Markdown.");
  }
}

function loadSelectedMarkdown(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = "";
  bookImport?.abort();
  const version = ++importVersion;
  const reader = new FileReader();
  const config = file.name.toLowerCase() === "euphoria demo.txt" ? state.config : standardConversionConfig();
  reader.addEventListener("load", () => {
    if (version === importVersion) loadDocument(String(reader.result), file.name, config);
  });
  reader.readAsText(file);
}

function standardConversionConfig() {
  return {
    format: "ttrpg-book-conversion",
    version: 1,
    rules: {
      entryHeadingLevel: 2,
      pageBreaks: "ignore",
      images: { defaultPlacement: "inline", ignorePositioning: true, ignoredAlt: ["background", "menu", "nameBanner"], ignoredSourcePatterns: ["background", "transparent"] }
    },
    overrides: []
  };
}

async function loadSelectedBook(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = "";
  bookImport?.abort();
  const request = new AbortController();
  bookImport = request;
  const version = ++importVersion;
  try {
    const { bookPackage, images } = /\.zip$/i.test(file.name)
      ? await window.bookArchive.open(file, validateBookPackage, request.signal)
      : { bookPackage: JSON.parse(await file.text()) };
    request.signal.throwIfAborted();
    if (version !== importVersion) return;
    validateBookPackage(bookPackage);
    state.sourceTheme = bookPackage.theme;
    state.paletteMode = "custom";
    const config = { rules: { entryHeadingLevel: bookPackage.conversion?.entryHeadingLevel || 2 } };
    loadPackage(bookPackage, file.name, "", config, images);
  } catch (error) {
    if (!request.signal.aborted && version === importVersion) showNotice(`Could not open ${file.name}. ${error.message}`);
  }
}

function loadDocument(source, fileName, config = {}) {
  const parsed = parseDocument(source, config);
  state.sourceTheme = themeFromCss(parsed.css);
  state.paletteMode = "source";
  const bookPackage = buildBookPackage(source, fileName, parsed, config);
  loadPackage(bookPackage, fileName, source, config);
}

function loadPackage(bookPackage, fileName, source = "", config = {}, images = new Map()) {
  let normalizedBreakFields = 0;
  normalizeBookText(bookPackage, () => { normalizedBreakFields += 1; });
  const bundledImages = new Map();
  try {
    for (const [path, blob] of images) bundledImages.set(path, { blob, url: URL.createObjectURL(blob) });
  } catch (error) {
    for (const image of bundledImages.values()) URL.revokeObjectURL(image.url);
    throw error;
  }
  const previousImages = state.bundledImages;
  if ($("#headingEditor").open) $("#headingEditor").close();
  if ($("#bookReprocess").open) $("#bookReprocess").close();
  reprocessDraft = null;
  state.normalizedBreakFieldsOnLoad = normalizedBreakFields;
  if ($("#bookZipExport").open) $("#bookZipExport").close();
  window.bookmakerPdf?.setBookAvailable(Boolean(bookPackage));
  for (const image of state.recoveredImages.values()) URL.revokeObjectURL(image.url);
  state.recoveredImages.clear();
  state.headingHistory.length = 0;
  state.visualEdits = !source;
  window.bookEditing?.reset();
  $("#undoHeadings").disabled = true;
  state.bookPackage = bookPackage;
  state.bundledImages = bundledImages;
  state.entries = bookPackage.entries || [];
  state.source = source;
  state.config = config;
  state.search = "";
  $("#searchInput").value = "";
  if (state.visualEdits) refreshEditedImageSlots();
  else refreshImageSlots();
  $("#openHeadings").disabled = state.visualEdits
    ? !state.entries.some((entry) => entry.blocks.some((block) => block.type === "heading"))
    : !findMarkdownHeadings(source, markdownHeader(source).end).length;
  if (!state.sourceTheme) state.sourceTheme = bookPackage.theme;
  state.currentPage = 0;
  applyPackageMeta(bookPackage);
  renderContents();
  renderPage();
  $(".reader-stage").scrollTo({ top: 0, left: 0 });
  setStatus(`Loaded ${fileName}`);
  $("#exportButton").disabled = false;
  $("#reprocessBook").disabled = false;
  updateExportLabel();
  for (const image of previousImages.values()) URL.revokeObjectURL(image.url);
}

function openHeadingEditor() {
  const headings = state.visualEdits ? state.entries.flatMap((entry) => entry.blocks
    .filter((block) => block.type === "heading").map((block) => ({ block, title: block.text, level: block.level })))
    : findMarkdownHeadings(state.source, markdownHeader(state.source).end);
  const levels = [1, 2, 3, 4, 5, 6];
  const byLevel = levels.map(() => new Map());
  headings.forEach(({ level, title }, index) => {
    const titles = byLevel[level - 1];
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title).push(index);
  });
  const groups = byLevel.flatMap((titles) => [...titles.values()].map((indices) => ({ indices, original: headings[indices[0]] })));
  const options = levels.map((level) => `<option value="${level}">H${level}</option>`).join("");
  const columns = levels.map((level) => {
    const rows = groups.map((group, index) => {
      if (group.original.level !== level) return "";
      const name = escapeAttribute(group.original.title);
      const count = group.indices.length;
      const description = `${count} occurrence${count === 1 ? "" : "s"}`;
      return `<li class="heading-row" data-group="${index}">
        <input type="checkbox" aria-label="Select H${level} ${name}" />
        ${group.original.title.includes("\n") ? `<textarea rows="2" dir="auto" aria-label="Title for H${level} ${name}" aria-describedby="heading-count-${index}" title="${name}">${name}</textarea>` : `<input type="text" dir="auto" aria-label="Title for H${level} ${name}" aria-describedby="heading-count-${index}" value="${name}" title="${name}" />`}
        <span class="heading-count" id="heading-count-${index}" aria-label="${description}" title="${description}">${count}</span>
        <select aria-label="Level for H${level} ${name}">${options}</select>
      </li>`;
    }).join("");
    if (!rows && level > 4) return "";
    return `<section class="heading-column" aria-labelledby="heading-level-${level}">
      <h3 id="heading-level-${level}">H${level}</h3>
      <ul class="heading-rows">${rows}</ul>
      <p class="heading-hint heading-column-empty"${rows ? " hidden" : ""}>No headings</p>
    </section>`;
  });
  $("#headingRows").innerHTML = `<div class="heading-grid">${columns.slice(0, 4).join("")}</div>
    <div class="heading-grid heading-grid-extra">${columns.slice(4).join("")}</div>`;
  const board = $("#headingRows");
  const columnSections = [...board.querySelectorAll(".heading-column")];
  for (const row of board.querySelectorAll(".heading-row")) {
    const group = groups[Number(row.dataset.group)];
    const [selected, title, , level] = row.children;
    level.value = group.original.level;
    Object.assign(group, { row, selected, title, level });
  }
  headingDraft = { headings, groups, columnSections, preview: null };
  $("#headingEntryHint").textContent = `H${entryHeadingLevel(state.config)} headings start new entries. H1 headings label book parts. Bulk shifts stop at H1 and H6.`;
  $("#headingSearch").value = "";
  $("#headingMessage").textContent = "";
  showHeadingPreview(false);
  filterHeadingRows();
  $("#headingEditor").showModal();
}

function filterHeadingRows() {
  const query = $("#headingSearch").value.trim().toLowerCase();
  let visible = 0;
  for (const { row, title } of headingDraft.groups) {
    row.hidden = !title.value.toLowerCase().includes(query);
    if (!row.hidden) visible += 1;
  }
  for (const column of headingDraft.columnSections) {
    column.querySelector(".heading-column-empty").hidden = Boolean(column.querySelector(".heading-row:not([hidden])"));
  }
  $("#headingEmpty").hidden = visible > 0;
  updateHeadingControls();
}

function updateHeadingControls() {
  const { groups } = headingDraft;
  const selected = groups.filter(({ selected }) => selected.checked);
  const visible = groups.filter(({ row }) => !row.hidden);
  const selectedVisible = visible.filter(({ selected }) => selected.checked).length;
  const selectAll = $("#selectHeadings");
  selectAll.disabled = !visible.length;
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  const occurrences = selected.reduce((count, group) => count + group.indices.length, 0);
  $("#headingSelection").textContent = `${selected.length} selected · ${occurrences} heading${occurrences === 1 ? "" : "s"}`;
  $("#updateSelectedHeadings").disabled = !selected.length;
  $("#previewHeadings").disabled = !groups.some(({ title, level, original }) =>
    title.value !== original.title && title.value.trim() !== original.title || Number(level.value) !== original.level);
}

function selectVisibleHeadings() {
  for (const { row, selected } of headingDraft.groups) {
    if (!row.hidden) selected.checked = $("#selectHeadings").checked;
  }
  updateHeadingControls();
}

function updateSelectedHeadingLevels() {
  const operation = $("#headingBulkOperation").value;
  for (const { selected, level } of headingDraft.groups) {
    if (!selected.checked) continue;
    if (operation === "up") level.value = Math.max(1, Number(level.value) - 1);
    else if (operation === "down") level.value = Math.min(6, Number(level.value) + 1);
    else level.value = operation;
  }
  updateHeadingControls();
}

function previewHeadingChanges() {
  const { headings, groups } = headingDraft;
  const empty = groups.find(({ title }) => !title.value.trim());
  if (empty) {
    $("#headingSearch").value = "";
    filterHeadingRows();
    $("#headingMessage").textContent = "Enter a title for every heading before previewing.";
    empty.title.focus();
    return;
  }

  const edits = [];
  for (const group of groups) {
    const value = group.title.value === group.original.title ? group.original.title : group.title.value.trim();
    const edit = { title: state.visualEdits ? normalizeBreaks(value) : value, level: Number(group.level.value) };
    for (const index of group.indices) edits[index] = edit;
  }
  if (state.visualEdits) {
    const changed = new Map(headings.flatMap((heading, index) => {
      const edit = edits[index];
      return edit.title === heading.title && edit.level === heading.level ? [] : [[heading.block, edit]];
    }));
    const entries = regroupEditedHeadings(changed);
    renderHeadingPreview({ entries, count: changed.size });
    return;
  }
  let source = state.source;
  let changed = 0;
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const { title, level } = edits[index];
    if (title === heading.title && level === heading.level) continue;
    const replacement = `${heading.indent}${"#".repeat(level)}${heading.space}${title}${heading.suffix}`;
    source = source.slice(0, heading.index) + replacement + source.slice(heading.index + heading.length);
    changed += 1;
  }
  const bookPackage = buildHeadingPackage(source);
  renderHeadingPreview({ source, bookPackage, entries: bookPackage.entries, count: changed });
}

function renderHeadingPreview(preview) {
  headingDraft.preview = preview;
  const { entries, count } = preview;
  $("#headingPreviewSummary").textContent = `${count} heading changes. Entries before and after: ${state.entries.length} → ${entries.length}.`;
  $("#headingPreviewContents").innerHTML = bookContentsRows(entries).map((row) => {
    if (row.type === "part") return '<li class="heading-preview-part">H1 · ' + escapeHtml(row.title) + "</li>";
    const { entry } = row;
    const sections = entry.blocks.filter((block) => block.type === "heading" && block.level === 3);
    const list = sections.map((block) => `<li>${escapeHtml(block.text)}</li>`).join("");
    return `<li><strong>${escapeHtml(entry.title)}</strong>${list ? `<ul>${list}</ul>` : ""}</li>`;
  }).join("");
  showHeadingPreview(true);
}

function showHeadingPreview(show) {
  $("#headingEditView").hidden = show;
  $("#headingPreviewView").hidden = !show;
  (show ? $("#headingPreviewTitle") : $("#headingSearch")).focus();
}

function buildHeadingPackage(source) {
  return buildBookPackage(source, state.bookPackage.source.fileName, parseDocument(source, state.config), state.config);
}

function applyHeadingChanges() {
  if (!headingDraft.preview) return;
  const { source, bookPackage, entries } = headingDraft.preview;
  state.headingHistory.push(state.visualEdits ? state.entries : state.source);
  $("#headingEditor").close();
  if (state.visualEdits) applyEditedEntries(entries);
  else updateBookWithHeadings(source, bookPackage);
  showNotice("Heading changes applied.");
}

function undoHeadingEdit() {
  const previous = state.headingHistory.pop();
  if (previous === undefined) return;
  if (state.visualEdits) applyEditedEntries(previous);
  else updateBookWithHeadings(previous, buildHeadingPackage(previous));
  showNotice("Heading change undone.");
}

function regroupEditedHeadings(changes, currentEntries = state.entries) {
  const entries = [];
  const level = entryHeadingLevel(state.config);
  const ids = new Set(currentEntries.map(({ id }) => id));
  function startEntry(title) {
    const base = slugify(title) || "entry";
    let id = base;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
    ids.add(id);
    entries.push({ id, title, blocks: [] });
  }
  let firstDemotedToPart = false;
  for (const entry of currentEntries) {
    const leadIndex = Math.max(0, entryHeadingIndex(entry.blocks, level));
    const lead = entry.blocks[leadIndex];
    const change = changes.get(lead);
    const leadChange = lead?.type === "heading" && (lead.level === level || change?.level === level) && change;
    const prefixPromotion = entry.blocks.findIndex((block, index) => index < leadIndex && changes.get(block)?.level === level);
    function startOriginalEntry() {
      if (!leadChange || leadChange.level === level || !entries.length) {
        const demotedToPart = leadChange?.level === 1 && level > 1;
        if (demotedToPart && !entries.length) firstDemotedToPart = true;
        entries.push({ ...entry, title: demotedToPart ? "Welcome" : leadChange?.title || entry.title, blocks: [] });
      } else {
        const current = entries.at(-1);
        current[sourceArtifact] = [...(current[sourceArtifact] || []), ...(entry[sourceArtifact] || [])];
      }
    }
    if (prefixPromotion >= 0) startEntry(changes.get(entry.blocks[prefixPromotion]).title);
    else startOriginalEntry();
    for (const [index, original] of entry.blocks.entries()) {
      const edit = changes.get(original);
      const block = edit ? edit.block || { ...original, level: edit.level, text: stripMarkup(edit.title) } : original;
      if (prefixPromotion >= 0 && index === leadIndex) startOriginalEntry();
      else if (index !== leadIndex && index !== prefixPromotion && edit?.level === level && original.level !== level) startEntry(edit.title);
      entries.at(-1).blocks.push(block);
    }
  }
  if (firstDemotedToPart && entries.length > 1) {
    const intro = entries.shift();
    const next = entries[0];
    next.blocks = [...intro.blocks, ...next.blocks];
    next[sourceArtifact] = [...(intro[sourceArtifact] || []), ...(next[sourceArtifact] || [])];
  }
  return entries;
}

function applyEditedEntries(entries, { keepHeadingHistory = true, keepReplacementHistory = false, currentEntryId = state.entries[state.currentPage]?.id } = {}) {
  if (!keepReplacementHistory) window.bookEditing?.clearReplacementHistory();
  const currentId = currentEntryId;
  if (!state.visualEdits || !keepHeadingHistory) state.headingHistory.length = 0;
  state.visualEdits = true;
  state.entries = entries.map((entry, order) => ({ ...entry, order }));
  state.bookPackage.entries = state.entries;
  normalizeBookText(state.bookPackage);
  const index = state.entries.findIndex(({ id }) => id === currentId);
  state.currentPage = index < 0 ? Math.max(0, Math.min(state.currentPage, state.entries.length - 1)) : index;
  refreshEditedImageSlots();
  window.imageRecovery?.invalidate();
  $("#openHeadings").disabled = !entries.some((entry) => entry.blocks.some((block) => block.type === "heading"));
  $("#undoHeadings").disabled = !state.headingHistory.length;
  $("#statPages").textContent = entries.length;
  $("#pageCount").textContent = `${entries.length} entries`;
  $("#statImages").textContent = state.bookPackage.assets.filter((asset) => !asset.ignored).length;
  $("#statTables").textContent = entries.reduce((sum, entry) => sum + entry.blocks.filter((block) => block.type === "table").length, 0);
  $("#statDirectives").textContent = entries.reduce((sum, entry) => sum + entry.blocks.length, 0);
  updateExportLabel();
  renderPage();
}

function updateBookWithHeadings(source, bookPackage) {
  bookPackage.theme = state.bookPackage.theme;
  state.source = source;
  state.bookPackage = bookPackage;
  state.entries = bookPackage.entries;
  refreshImageSlots();
  state.currentPage = Math.min(state.currentPage, state.entries.length - 1);
  $("#undoHeadings").disabled = !state.headingHistory.length;
  applyPackageMeta(bookPackage);
  renderPage();
}

function markdownHeader(source) {
  let end = 0;
  const header = {};
  for (let index = 0; index < 2; index += 1) {
    const block = source.slice(end).match(/^\s*```(metadata|css)[ \t]*\r?\n([\s\S]*?)^ {0,3}```[ \t]*(?=\r?$)/im);
    if (!block || block.index !== 0) break;
    header[block[1].toLowerCase()] = block[2];
    end += block[0].length;
  }
  return { metadata: parseMetadata(header.metadata || ""), css: header.css || "", end };
}

function parseDocument(source, config = {}) {
  const { metadata, css, end } = markdownHeader(source);
  const body = source.slice(end).trim();
  const pageBreaks = (body.match(/\\page\b/g) || []).length;
  const allBody = prepareSourcePages(body);
  const entries = buildEntries(allBody, config);
  const keptImages = allBody.split(/\r?\n/).map(parseMarkdownImage)
    .filter((image) => image && !shouldIgnoreImage(image.alt, image.url, config, image.fullPage)).length;
  return { metadata, css, entries, pageBreaks, images: keptImages, tables: (allBody.match(/\{\{fancyTable\b/gi) || []).length, directives: (allBody.match(/\{\{[^\n}]*/g) || []).length };
}

// Determine image-only pages before removing the printed-page boundaries. Mark
// individual occurrences rather than URLs: the same artwork can be decoration on
// a different page, and those normal image filtering rules should still apply.
function prepareSourcePages(body, separator = "\n") {
  return body.split(/\\page\b/g).map((page) => {
    const visible = cleanSource(page).split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      line && !/^<!--.*-->$/.test(line) && !/^(?:<br[ \t]*\/?[ \t]*>\s*)+$/i.test(line));
    if (!visible.length || !visible.every((line) => parseMarkdownImage(line))) return page;
    return page.split(/\r?\n/).map((line) => {
      const image = parseMarkdownImage(line) || parseMarkdownImage(cleanSource(line));
      return image ? line + IMAGE_ONLY_PAGE_MARKER : line;
    }).join("\n");
  }).join(separator);
}

function findMarkdownHeadings(source, start = 0) {
  const headings = [];
  let fence = "";
  for (const line of source.slice(start).matchAll(/^[^\r\n]+/gm)) {
    const marker = line[0].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const heading = parseHeadingLine(line[0]);
    if (!heading) continue;
    headings.push({ ...heading, index: start + line.index, length: line[0].length });
  }
  return headings;
}

function parseHeadingLine(line) {
  const heading = line.match(/^( {0,3})(#{1,6})([ \t]+)(\S.*)$/);
  if (!heading) return null;
  const [, indent, hashes, space, content] = heading;
  const title = content.replace(/[ \t]+#+[ \t]*$/, "").trimEnd();
  return { indent, level: hashes.length, space, title, suffix: content.slice(title.length) };
}

function entryHeadingLevel(config) {
  return config.rules?.entryHeadingLevel || config.entryHeadingLevel || 2;
}

function entryHeadingIndex(blocks, level = 2) {
  return blocks.findIndex((block) => block.type === "heading" && block.level === level);
}

function buildEntries(body, config = {}) {
  const withoutPageBreaks = body.replace(/\\page\b/g, "\n");
  const level = entryHeadingLevel(config);
  const headingMatches = [];
  let partStart;
  for (const heading of findMarkdownHeadings(withoutPageBreaks)) {
    if (heading.level === level) {
      headingMatches.push({ index: partStart ?? heading.index });
      partStart = undefined;
    } else if (heading.level === 1 && level > 1) {
      partStart ??= heading.index;
    }
  }
  if (!headingMatches.length) return [createEntry(withoutPageBreaks, 0, config)];
  const entries = [];
  const preamble = withoutPageBreaks.slice(0, headingMatches[0].index).trim();
  if (preamble) entries.push({ ...createEntry(preamble, 0, config), title: "Welcome" });
  headingMatches.forEach((match, index) => {
    const start = match.index;
    const end = headingMatches[index + 1]?.index ?? withoutPageBreaks.length;
    entries.push(createEntry(withoutPageBreaks.slice(start, end), entries.length, config));
  });
  return entries;
}

function createEntry(raw, index, config = {}) {
  const normalized = cleanSource(applyConversionRules(raw, config));
  const headings = findMarkdownHeadings(normalized);
  const firstHeading = headings.find((heading) => heading.level > 1 && heading.level <= 3);
  const entryHeading = headings.find((heading) => heading.level === entryHeadingLevel(config)) || firstHeading;
  const imageAlt = normalized.match(/!\[([^\]]+)\]/)?.[1];
  let title = entryHeading ? stripMarkup(entryHeading.title) : "";
  if (!title) title = index === 0 ? "Cover" : index === 1 ? "Inside cover" : imageAlt || `Entry ${index + 1}`;
  return { raw, normalized, headings, title };
}

function buildBookPackage(source, fileName, parsed, config = {}) {
  const assets = new Map();
  const entries = parsed.entries.map((entry, index) => {
    const blocks = markdownToBlocks(entry.normalized, config, assets);
    return { id: `${slugify(entry.title) || "entry"}-${index + 1}`, title: entry.title, order: index, blocks,
      [sourceArtifact]: collectSourceArtifacts(entry.raw, blocks, config) };
  });
  const metadata = parsed.metadata;
  return normalizeBookText({
    format: "ttrpg-book",
    schemaVersion: 1,
    book: { id: slugify(metadata.title) || "untitled-book", title: metadata.title, description: metadata.description || "Imported Homebrewery Markdown book.", version: "0.1.0", tags: ["homebrewery-import"] },
    source: { format: "homebrewery-markdown", fileName },
    conversion: { entryHeadingLevel: config.rules?.entryHeadingLevel || 2, pageBreaks: config.rules?.pageBreaks || "ignore", imagePolicy: { defaultPlacement: config.rules?.images?.defaultPlacement || "inline", ignoredRoles: ["background", "page-overlay", "menu", "decorative-banner"], ignorePositioning: config.rules?.images?.ignorePositioning !== false } },
    theme: themeFromCss(parsed.css),
    assets: [...assets.values()],
    entries
  });
}

function defaultTheme() {
  return {
    tokens: { "color.background": "#f5ead2", "color.backgroundLight": "#fbf4e5", "color.surface": "#efe0c0", "color.primary": "#6f2637", "color.primaryDark": "#4d1a25", "color.accent": "#b68a3d", "color.accentLight": "#d9b86c", "color.accentDark": "#7a5927", "color.secondary": "#5d466f", "color.text": "#4a3825", "color.textMuted": "#7a6143", "color.border": "#c8a463", "color.hover": "#f8efd8", "font.body": "Georgia, serif", "font.ui": "Inter, sans-serif" },
    decorations: { parchmentTexture: true, ornamentalFrames: true, ornamentalDividers: true, tableHeaderStyle: "wine", imageCaptionStyle: "italic-muted" }
  };
}

function themeFromCss(css) {
  const theme = defaultTheme();
  const variableMap = { bg: "color.background", "bg-light": "color.backgroundLight", card: "color.surface", gold: "color.accent", "gold-light": "color.accentLight", "gold-dark": "color.accentDark", wine: "color.primary", "wine-dark": "color.primaryDark", plum: "color.secondary", text: "color.text", "text-light": "color.textMuted", border: "color.border", hover: "color.hover" };
  [...css.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/gi)].forEach((match) => {
    const token = variableMap[match[1].toLowerCase()];
    if (token) theme.tokens[token] = match[2].trim();
  });
  return theme;
}

function markdownToBlocks(source, config, assets) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line === "<!--COLUMN_BREAK-->") { blocks.push({ type: "divider", style: "column-break" }); index += 1; continue; }
    if (/^<div class=['"]video-section['"]>/i.test(line)) { blocks.push(parseVideoBlock(line)); index += 1; continue; }
    const image = parseMarkdownImage(line);
    if (image) {
      const { alt, url } = image;
      const rule = findImageRule(alt, url, config);
      if (!shouldIgnoreImage(alt, url, config, image.fullPage)) {
        const assetId = getAssetId(alt, url, assets);
        blocks.push({ type: "image", assetId, role: image.fullPage ? "full-page" : imageRole(alt), placement: rule?.location || "inline", className: rule?.className, width: rule?.width, [markdownImage]: image });
      }
      index += 1;
      continue;
    }
    const heading = parseHeadingLine(line);
    if (heading) { blocks.push({ type: "heading", level: heading.level, text: stripMarkup(heading.title) }); index += 1; continue; }
    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index].trim())) tableLines.push(lines[index++].trim());
      blocks.push(tableBlock(tableLines));
      continue;
    }
    if (listItemText(line) !== null) {
      const items = [];
      const start = line.match(/^(\d{1,9})[.)]\s+/);
      const ordered = Boolean(start);
      while (index < lines.length) {
        const item = listItemText(lines[index].trim());
        if (item !== null) {
          if (/^\d{1,9}[.)]\s+/.test(lines[index].trim()) !== ordered) break;
          items.push(item);
          index += 1;
        } else if (/^[ \t]+\S/.test(lines[index]) && !isStructuralLine(lines[index].trim())) {
          items[items.length - 1] += ` ${lines[index++].trim()}`;
        } else if (!lines[index].trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          if (next === lines.length || listItemText(lines[next].trim()) === null) break;
          if (/^\d{1,9}[.)]\s+/.test(lines[next].trim()) !== ordered) break;
          index = next;
        } else break;
      }
      blocks.push({ type: "list", items, ...(ordered && { ordered: true, start: Number(start[1]) }) });
      continue;
    }
    if (/^---+$/.test(line)) { blocks.push({ type: "divider", style: "rule" }); index += 1; continue; }
    if (/^<[^>]+>/.test(line) && !/^<br[ \t]*\/?[ \t]*>/i.test(line)) { index += 1; continue; }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isStructuralLine(lines[index].trim())) paragraph.push(lines[index++].trim());
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function getAssetId(alt, url, assets) {
  const baseId = slugify(alt) || `asset-${assets.size + 1}`;
  let id = baseId;
  let suffix = 2;
  while (assets.has(id) && assets.get(id).src !== url) id = `${baseId}-${suffix++}`;
  if (!assets.has(id)) assets.set(id, { id, src: url, alt: alt || id, role: imageRole(alt) });
  return id;
}

function parseMarkdownImage(line) {
  const text = line.trim();
  const fullPage = text.endsWith(IMAGE_ONLY_PAGE_MARKER);
  const match = (fullPage ? text.slice(0, -IMAGE_ONLY_PAGE_MARKER.length).trimEnd() : text).match(/^!\[([^\]]*)\]\(\s*(<[^>]+>|(?:[^()]|\([^()]*\))+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)(?:\s*\{[^}]*\})*$/);
  const url = match?.[2].trim().replace(/^<|>$/g, "");
  return url ? { alt: match[1], url, ...(fullPage && { fullPage: true }) } : null;
}

function refreshImageSlots() {
  const contexts = new Map();
  const body = state.source.slice(markdownHeader(state.source).end);
  const source = prepareSourcePages(body, "\n\\page\n");
  const lines = source.split("\n");
  const headings = new Map(findMarkdownHeadings(source).map((item) => [item.index, item]));
  let offset = 0;
  const lineHeadings = lines.map((line) => {
    const heading = headings.get(offset);
    offset += line.length + 1;
    return heading;
  });
  const followingH3 = [];
  let nextH3;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const title = lineHeadings[index];
    if (title?.level <= 2) nextH3 = null;
    if (title?.level === 3) nextH3 = { index, title: stripMarkup(title.title) };
    followingH3[index] = nextH3;
  }
  const hasPages = lines.includes("\\page");
  let page = 1;
  let heading = "";
  let h2 = "";
  let previousH3;
  lines.forEach((line, index) => {
    if (line === "\\page") page += 1;
    const title = lineHeadings[index];
    if (title) heading = stripMarkup(title.title);
    if (title?.level <= 2) {
      h2 = title.level === 2 ? heading : "";
      previousH3 = null;
    }
    if (title?.level === 3) previousH3 = { index, title: heading };
    const image = parseMarkdownImage(line);
    if (!image || shouldIgnoreImage(image.alt, image.url, state.config, image.fullPage)) return;
    const next = followingH3[index];
    const nearestH3 = next && (!previousH3 || next.index - index < index - previousH3.index) ? next : previousH3;
    const pair = JSON.stringify([image.alt, image.url]);
    if (!contexts.has(pair)) contexts.set(pair, []);
    const before = nearbyImageText(lines, index, -1);
    const after = nearbyImageText(lines, index, 1);
    const caption = [after, before].find((text) => /^(?:(?:fig(?:ure)?\.?|caption)\s|\*[^*]+\*$|_[^_]+_$)/i.test(text));
    contexts.get(pair).push({
      page: hasPages ? page : null, heading, h2, h3: nearestH3?.title || "", before: stripMarkup(before), after: stripMarkup(after),
      caption: caption ? stripMarkup(caption) : ""
    });
  });

  state.imageSlots = [];
  state.previewImages = new WeakMap();
  const occurrences = new Map();
  state.entries.forEach((entry, entryIndex) => {
    entry.blocks.forEach((block, blockIndex) => {
      const image = block[markdownImage];
      if (!image) return;
      const pair = JSON.stringify([image.alt, image.url]);
      const occurrence = occurrences.get(pair) || 0;
      occurrences.set(pair, occurrence + 1);
      const key = JSON.stringify([image.alt, image.url, occurrence]);
      const context = contexts.get(pair)?.[occurrence] || { page: null, heading: entry.title, before: "", after: "", caption: "" };
      block[imageSlotContext] = { ...image, ...context, key };
      state.imageSlots.push({ ...block[imageSlotContext], entryIndex, blockIndex, entryTitle: entry.title });
      const recovery = state.recoveredImages.get(key);
      if (recovery) state.previewImages.set(block, recovery);
    });
  });
}

function refreshEditedImageSlots() {
  const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
  state.imageSlots = [];
  state.previewImages = new WeakMap();
  for (const [entryIndex, entry] of state.entries.entries()) {
    let heading = entry.title;
    let h3 = "";
    for (const [blockIndex, block] of entry.blocks.entries()) {
      if (block.type === "heading") {
        heading = block.text;
        if (block.level === 3) h3 = heading;
        if (block.level < 3) h3 = "";
      }
      if (block.type !== "image" || block[sourceHidden]) continue;
      const asset = assets.get(block.assetId);
      if (!asset) continue;
      const context = block[imageSlotContext] ||= { key: `edited-image-${++editedImageId}`, page: null, before: "", after: "", caption: "" };
      const recovery = state.recoveredImages.get(context.key);
      if (recovery) state.previewImages.set(block, recovery);
      if (asset.src === "about:blank") continue;
      state.imageSlots.push({ ...context, alt: block.alt ?? asset.alt, url: asset.src, heading,
        h2: entry.title, h3: h3 || context.h3 || "", entryIndex, blockIndex, entryTitle: entry.title });
    }
  }
}

function collectSourceArtifacts(source, blocks, config) {
  const items = [];
  const headings = blocks.filter((block) => block.type === "heading");
  let heading = "";
  let anchor;
  let searchStart = 0;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const title = parseHeadingLine(line);
    if (title) {
      heading = stripMarkup(title.title);
      const index = headings.findIndex((block, index) => index >= searchStart && block.text === heading && block.level === title.level);
      if (index >= 0) {
        anchor = headings[index][sourceHeadingKey] ||= Symbol();
        searchStart = index + 1;
      } else anchor = undefined;
    }
    const image = parseMarkdownImage(line);
    if (image && shouldIgnoreImage(image.alt, image.url, config, image.fullPage)) items.push({ label: image.alt || image.url, image, heading, anchor });
    const directiveLine = line.endsWith(IMAGE_ONLY_PAGE_MARKER) ? line.slice(0, -IMAGE_ONLY_PAGE_MARKER.length).trimEnd() : line;
    const directive = directiveLine.match(/^\{\{([\w-]+)\b(.*?)(?:\}\})?$/);
    if (directive) items.push({ label: directive[1], text: directive[2].trim().replace(/^,\s*/, ""), heading, anchor });
  }
  return items;
}

function nearbyImageText(lines, start, direction) {
  for (let index = start + direction; index >= 0 && index < lines.length; index += direction) {
    const line = lines[index].trim();
    if (/^\\page\b|^\\column\b/.test(line) || parseHeadingLine(line) || parseMarkdownImage(line)) return "";
    if (line && !/^(?:[{}:]+|\{\{.*|<!--.*)$/.test(line)) return line.slice(0, 240);
  }
  return "";
}

function updateImageRecovery(slot, image) {
  window.bookEditing?.clearReplacementHistory();
  const block = state.entries[slot.entryIndex].blocks[slot.blockIndex];
  const previous = state.recoveredImages.get(slot.key);
  if (image) {
    const recovery = { ...image, caption: normalizeBreaks(image.caption ?? ""), url: URL.createObjectURL(image.blob) };
    state.recoveredImages.set(slot.key, recovery);
    state.previewImages.set(block, recovery);
  } else {
    state.recoveredImages.delete(slot.key);
    state.previewImages.delete(block);
  }
  if (previous) URL.revokeObjectURL(previous.url);
  updateExportLabel();
  state.currentPage = slot.entryIndex;
  renderPage();
}

function showRecoveredImage(slot) {
  const current = state.imageSlots.find(({ key }) => key === slot.key);
  if (!current) return;
  if (state.currentPage !== current.entryIndex) {
    state.currentPage = current.entryIndex;
    renderPage();
  }
  const image = $(`#pageViewport [data-recovered-block="${current.blockIndex}"]`);
  image?.decode().catch(() => {}).then(() => {
    if (image.isConnected) {
      image.focus({ preventScroll: true });
      image.scrollIntoView({ block: "center" });
    }
  });
}

function imageRole(alt) {
  const label = alt.toLowerCase();
  if (label.includes("emblem")) return "emblem";
  if (label.includes("npc") || label.includes("owner") || label.includes("bartender")) return "portrait";
  if (label.includes("artifact")) return "artifact";
  if (label.includes("location") || label.includes("hub")) return "location";
  return "illustration";
}

function tableBlock(lines) {
  const rows = lines.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  return { type: "table", columns: rows[0] || [], rows: rows.slice(2).filter((row) => row.some(Boolean)) };
}

function parseVideoBlock(line) {
  const title = line.match(/<h2>(.*?)<\/h2>/i)?.[1] || "Video resources";
  const items = [...line.matchAll(/<a href=['"]([^'"]+)['"][^>]*>\s*<img src=['"]([^'"]+)['"]/gi)].map((match) => ({ url: match[1], thumbnail: match[2] }));
  return { type: "embed", kind: "video-grid", title, items };
}

function applyConversionRules(source, config) {
  const lines = source.split(/\r?\n/);
  const moved = [];
  const kept = lines.filter((line) => {
    const image = parseMarkdownImage(line);
    if (!image) return true;
    const rule = findImageRule(image.alt, image.url, config);
    if (rule?.action === "ignore") return false;
    if (rule?.action === "move") { moved.push(line); return false; }
    return true;
  });
  if (!moved.length) return kept.join("\n");
  const location = findImageRule(extractImageAlt(moved[0]), "", config)?.location;
  if (["entry-top", "entry-top-right"].includes(location)) {
    const level = config.rules?.entryHeadingLevel || 2;
    const headingIndex = kept.findIndex((line) => new RegExp(`^${"#".repeat(level)}\\s+`).test(line.trim()));
    kept.splice(headingIndex < 0 ? 0 : headingIndex + 1, 0, "", ...moved, "");
  } else kept.push("", ...moved);
  return kept.join("\n");
}

function findImageRule(alt, url, config = {}) {
  const rules = config.overrides || config.images || [];
  return rules.find((rule) => {
    const match = rule.match || {};
    const altMatches = match.alt ? (Array.isArray(match.alt) ? match.alt : [match.alt]).some((value) => value.toLowerCase() === alt.trim().toLowerCase()) : true;
    const urlMatches = match.urlIncludes ? url.toLowerCase().includes(match.urlIncludes.toLowerCase()) : true;
    return altMatches && urlMatches;
  });
}

function extractImageAlt(line) { return line.match(/^!\[([^\]]*)\]/)?.[1] || ""; }

function cleanSource(source) {
  return unwrapHomebreweryText(source).replace(/^[ \t]*\{\{[^\n]*$/gm, "").replace(/^[ \t]*\}\}[ \t]*$/gm, "")
    .replace(/^[ \t]*\{[\w-]+\s*:[^}\n]+\}[ \t]*$/gm, "").replace(/^[ \t]*:{1,}[ \t]*$/gm, "")
    .replace(/^[ \t]*\|+[ \t]*$/gm, "").replace(/^[ \t]*\\column[ \t]*$/gm, "\n<!--COLUMN_BREAK-->\n").trim();
}

function unwrapHomebreweryText(value) {
  let text = value;
  while (/\{\{[^{}\n]*\}\}/.test(text)) {
    text = text.replace(/\{\{([^{}\n]*)\}\}/g, (_, content) => {
      if (/^\s/.test(content)) return content.trim();
      const match = content.match(/^((?:[^\s"']|"[^"]*"|'[^']*')+)(?:[ \t]+([\s\S]*))?$/);
      if (!match || /^(?:frontCover|insideCover|backCover|banner|pageNumber|footnote|watermark|logo)(?:,|$)/i.test(match[1])) return "";
      return match[2]?.trim() || "";
    });
  }
  return text;
}

function shouldIgnoreImage(alt, url, config = {}, fullPage = false) {
  const label = alt.trim().toLowerCase();
  const source = url.toLowerCase();
  const configuredIgnore = findImageRule(alt, url, config)?.action === "ignore";
  // A layout label must not erase the only content on a printed page.
  // An explicit per-image ignore override still takes precedence.
  if (fullPage) return configuredIgnore;
  const ignoredAlt = config.rules?.images?.ignoredAlt || [];
  const ignoredPatterns = config.rules?.images?.ignoredSourcePatterns || [];
  return configuredIgnore || ignoredAlt.some((value) => value.toLowerCase() === label) || ignoredPatterns.some((value) => source.includes(value.toLowerCase())) || ["background", "menu", "namebanner"].includes(label) || /(?:background|transparent)\.(?:webp|png|jpe?g)(?:\?|$)/i.test(source);
}

function renderPackageBlock(block, assets, entryIndex, blockIndex) {
  if (block.type === "heading") { const level = Math.min(Math.max(Math.trunc(block.level) || 2, 1), 6); const id = level === 3 ? ` id="entry-${entryIndex}-section-${blockIndex}"` : ""; return `<h${level}${id}>${inlineMarkdown(block.text)}</h${level}>`; }
  if (block.type === "paragraph") {
    const text = inlineMarkdown(block.text);
    if (block.style === "book-quote") return `<blockquote class="book-quote">${text}</blockquote>`;
    return `<p${block.style ? ` class="${escapeAttribute(block.style)}"` : ""}>${text}</p>`;
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const start = block.ordered && Number.isSafeInteger(block.start) ? ` start="${block.start}"` : "";
    return `<${tag}${start}>${block.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`;
  }
  if (block.type === "table") return `<table><thead><tr>${block.columns.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  if (block.type === "divider") return block.style === "rule" ? '<hr class="book-rule">' : `<div class="column-marker" aria-hidden="true"></div>`;
  if (block.type === "image") {
    const recovery = state.previewImages.get(block);
    const original = assets.find((candidate) => candidate.id === block.assetId);
    const asset = recovery ? { src: recovery.url, alt: recovery.caption } : original && {
      ...original, src: state.bundledImages.get(original.src)?.url || original.src
    };
    if (!asset) return "";
    const semanticClass = block.role === "emblem" ? " entry-emblem" : block.role === "full-page" ? " page-art--full-page" : "";
    const placementClass = block.placement === "entry-top-right" ? " entry-emblem--top-right" : "";
    const customClass = block.className ? ` ${block.className.replace(/[^a-z0-9_-]/gi, "")}` : "";
    const className = `${semanticClass}${placementClass}${customClass}`;
    const width = block.width ? ` style="width:${escapeAttribute(block.width)}"` : "";
    const loading = recovery ? `data-recovered-block="${blockIndex}" loading="eager"`
      : state.bundledImages.has(original?.src) ? 'loading="eager"' : 'loading="lazy"';
    const alt = block.alt ?? asset.alt;
    const caption = recovery?.caption ?? block.caption ?? asset.alt;
    return `<figure class="page-art page-art--flow${className}"${width}><span class="image-frame"><img src="${escapeAttribute(asset.src)}" alt="${escapeAttribute(alt)}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(alt)}" data-image-viewer tabindex="0" ${loading}></span>${caption ? `<figcaption>${inlineMarkdown(caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.type === "embed" && block.kind === "video-grid") return `<section><h3>${inlineMarkdown(block.title)}</h3><div class="video-grid">${block.items.map((item, index) => `<a class="video-card" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer"><span class="image-frame image-frame--wide"><img src="${escapeAttribute(item.thumbnail)}" alt="${escapeAttribute(block.title)} video ${index + 1}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(block.title)} video ${index + 1}" data-image-viewer tabindex="0" loading="lazy"></span><span class="video-card-caption">Watch ${escapeHtml(block.title)} video ${index + 1} ↗</span></a>`).join("")}</div></section>`;
  return "";
}

function renderContents() {
  renderBookContents(state.entries, state.currentPage, state.search, "data-page", goToPage, (block) => !block[sourceHidden]);
}

function renderPage() {
  const entry = state.entries[state.currentPage];
  if (!state.bookPackage) return;
  if (!entry) {
    $("#pageViewport").replaceChildren();
    $("#currentPage").textContent = "0";
    $("#totalPages").textContent = "0";
    $("#currentLabel").textContent = "No entries";
    $("#previousButton").disabled = $("#nextButton").disabled = true;
    $("#sourceSlice").textContent = "";
    renderContents();
    return;
  }
  const html = entry.blocks.map((block, blockIndex) => {
    if (block[sourceHidden]) return "";
    const content = renderPackageBlock(block, state.bookPackage.assets, state.currentPage, blockIndex);
    return window.bookEditing?.active ? window.bookEditing.wrapBlock(block, blockIndex, content) : content;
  }).join("\n");
  const addFirst = window.bookEditing?.active && !entry.blocks.some((block) => !block[sourceHidden])
    ? '<div class="book-block-actions"><button type="button" data-book-add="0">Add block</button></div>' : "";
  $("#pageViewport").innerHTML = `<article class="book-page"><div class="page-inner"><div class="page-content">${html}${addFirst}</div></div></article>`;
  $("#currentPage").textContent = state.currentPage + 1;
  $("#totalPages").textContent = state.entries.length;
  $("#currentLabel").textContent = entry.title;
  $("#previousButton").disabled = state.currentPage === 0;
  $("#nextButton").disabled = state.currentPage === state.entries.length - 1;
  $("#sourceSlice").textContent = JSON.stringify(entry, null, 2);
  renderContents();
}

function goToPage(index) {
  if (index < 0 || index >= state.entries.length) return;
  state.currentPage = index;
  renderPage();
  $(".reader-stage").scrollTo({ top: 0, behavior: "smooth" });
}

function applyPackageMeta(bookPackage) {
  const blockCount = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.length, 0);
  $("#bookTitle").textContent = bookPackage.book.title;
  $("#bookDescription").textContent = bookPackage.book.description || "Imported TTRPG book package.";
  $("#themeLabel").textContent = `JSON v${bookPackage.schemaVersion}`;
  $("#pageCount").textContent = `${bookPackage.entries.length} entries`;
  $("#totalPages").textContent = bookPackage.entries.length;
  $("#statPages").textContent = bookPackage.entries.length;
  $("#statImages").textContent = bookPackage.assets.filter((asset) => !asset.ignored).length;
  $("#statTables").textContent = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.filter((block) => block.type === "table").length, 0);
  $("#statDirectives").textContent = blockCount;
  applyTheme(bookPackage.theme);
  renderThemeControls(bookPackage.theme, state.sourceTheme || bookPackage.theme);
  document.title = `${bookPackage.book.title} · Content Reader`;
}

const THEME_PRESETS = {
  classic: () => defaultTheme(),
  midnight: () => ({ ...defaultTheme(), tokens: { ...defaultTheme().tokens, "color.background": "#21191d", "color.backgroundLight": "#302027", "color.surface": "#3b252d", "color.primary": "#d9b86c", "color.primaryDark": "#f4dfb6", "color.accent": "#b68a3d", "color.text": "#f6e8d2", "color.textMuted": "#cfb7a1", "color.border": "#7d5360" } }),
  ember: () => ({ ...defaultTheme(), tokens: { ...defaultTheme().tokens, "color.background": "#f1dfc4", "color.backgroundLight": "#fff5e4", "color.surface": "#ead0a7", "color.primary": "#9b3f24", "color.primaryDark": "#652516", "color.accent": "#c16a2d", "color.accentLight": "#e2a65d", "color.text": "#4b2b20", "color.textMuted": "#86614d", "color.border": "#c78e54" } })
};

const PALETTE_FIELDS = [
  ["color.background", "Page"],
  ["color.backgroundLight", "Light page"],
  ["color.surface", "Surface"],
  ["color.primary", "Primary"],
  ["color.primaryDark", "Dark primary"],
  ["color.accent", "Accent"],
  ["color.accentLight", "Light accent"],
  ["color.accentDark", "Dark accent"],
  ["color.secondary", "Secondary"],
  ["color.text", "Text"],
  ["color.textMuted", "Muted text"],
  ["color.border", "Border"],
  ["color.hover", "Hover"]
];

function cloneTheme(theme) { return JSON.parse(JSON.stringify(theme || defaultTheme())); }

function applySelectedTheme() {
  if (!state.bookPackage) return;
  const selected = $("#themePreset")?.value || "source";
  state.paletteMode = selected;
  if (selected === "source") state.bookPackage.theme = cloneTheme(state.sourceTheme || defaultTheme());
  else if (THEME_PRESETS[selected]) state.bookPackage.theme = THEME_PRESETS[selected]();
  applyTheme(state.bookPackage.theme);
  renderThemeControls(state.bookPackage.theme, state.sourceTheme || defaultTheme());
  renderPage();
  const label = selected === "source" ? "source CSS" : selected === "custom" ? "custom" : selected;
  showNotice(`Applied ${label} palette. Export JSON to save it.`);
}

function renderThemeControls(theme, sourceTheme) {
  const preset = $("#themePreset");
  if (!preset) return;
  preset.value = state.paletteMode;
  const sourceTokens = sourceTheme?.tokens || {};
  const activeTokens = theme?.tokens || {};
  const swatches = ["color.background", "color.primary", "color.accent", "color.text"];
  renderThemeSwatches(activeTokens, swatches);
  $("#cssTokenCount").textContent = `${Object.keys(sourceTokens).filter((token) => token.startsWith("color.")).length} CSS colors`;
  $("#themeNote").textContent = state.paletteMode === "source"
    ? "Image frames follow Accent. Use the controls below to customize this source palette."
    : state.paletteMode === "custom"
      ? "Image frames follow Accent. Pick a color or enter a CSS color value; changes save in the book JSON."
      : "Using a Maker preset. Image frames follow its Accent color; adjust any color below.";
  $("#paletteColorControls").innerHTML = PALETTE_FIELDS.map(([token, label]) => {
    const value = String(activeTokens[token] || defaultTheme().tokens[token] || "#000000");
    const pickerValue = colorInputHex(value, defaultTheme().tokens[token] || "#000000");
    return `<label class="palette-color-field"><span>${label}</span><span class="palette-color-inputs"><input type="color" data-palette-picker="${token}" value="${escapeAttribute(pickerValue)}" aria-label="Choose ${label} color"><input type="text" data-palette-value="${token}" value="${escapeAttribute(value)}" spellcheck="false" aria-label="${label} color value"></span></label>`;
  }).join("");
}

function renderThemeSwatches(tokens, swatches = ["color.background", "color.primary", "color.accent", "color.text"]) {
  $("#themeSwatches").innerHTML = swatches.map((token) => `<span class="theme-swatch" title="${escapeAttribute(token)}" style="background:${escapeAttribute(tokens[token] || "transparent")}"></span>`).join("");
}

function colorInputHex(value, fallback) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return /^#[\da-f]{6}$/i.test(value) ? value : fallback;
  context.fillStyle = fallback;
  context.fillStyle = String(value);
  const normalized = context.fillStyle;
  if (/^#[\da-f]{6}$/i.test(normalized)) return normalized;
  const rgb = normalized.match(/^rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i);
  return rgb ? `#${rgb.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}` : fallback;
}

function handlePaletteInput(event) {
  if (!state.bookPackage) return;
  const picker = event.target.closest("input[data-palette-picker]");
  const text = event.target.closest("input[data-palette-value]");
  const control = picker || text;
  if (!control) return;
  const token = picker ? picker.dataset.palettePicker : text.dataset.paletteValue;
  const value = control.value.trim();
  if (!isValidCssColor(value)) return;
  const colorPicker = $(`[data-palette-picker="${token}"]`);
  const colorText = $(`[data-palette-value="${token}"]`);
  if (picker) colorText.value = value;
  else colorPicker.value = colorInputHex(value, defaultTheme().tokens[token] || "#000000");
  state.paletteMode = "custom";
  $("#themePreset").value = "custom";
  state.bookPackage.theme.tokens[token] = value;
  applyTheme(state.bookPackage.theme);
  renderThemeSwatches(state.bookPackage.theme.tokens);
  $("#themeNote").textContent = "Image frames follow Accent. Pick a color or enter a CSS color value; changes save in the book JSON.";
  renderPage();
}

function handleInvalidPaletteValue(event) {
  const text = event.target.closest("input[data-palette-value]");
  if (!text || isValidCssColor(text.value.trim()) || !state.bookPackage) return;
  renderThemeControls(state.bookPackage.theme, state.sourceTheme || defaultTheme());
}

function isValidCssColor(value) {
  return Boolean(value) && (window.CSS?.supports?.("color", value) || /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value));
}

function applyTheme(theme = {}) {
  const root = document.documentElement;
  const aliases = { "color.background": "--parchment", "color.backgroundLight": "--parchment-light", "color.surface": "--card", "color.primary": "--wine", "color.primaryDark": "--wine-dark", "color.accent": "--gold", "color.accentLight": "--gold-light", "color.accentDark": "--gold-dark", "color.secondary": "--plum", "color.text": "--ink", "color.textMuted": "--ink-soft", "color.border": "--border", "color.hover": "--hover", "font.body": "--book-body-font", "font.ui": "--book-ui-font" };
  Object.entries(theme.tokens || {}).forEach(([token, value]) => { if (aliases[token]) root.style.setProperty(aliases[token], value); });
}

function updateExportLabel() {
  const book = window.bookEditing?.exportPackage() || state.bookPackage;
  $("#exportButton").textContent = hasBundledImages(book) ? "Export Book ZIP" : "Export JSON";
}

function hasBundledImages(book) {
  if (!book) return false;
  const sources = new Map(book.assets.map(({ id, src }) => [id, src]));
  return book.entries.some((entry) => entry.blocks.some((block) => block.type === "image" &&
    (state.previewImages.has(block) || state.bundledImages.has(sources.get(block.assetId)))));
}

function exportBook() {
  if (!state.bookPackage) return;
  const book = window.bookEditing?.exportPackage() || state.bookPackage;
  const importedName = book.source?.fileName?.split(/[\\/]/).pop();
  const baseName = importedName?.replace(/\.(?:txt|md|markdown)$/i, "") || book.book.id;
  const name = `${baseName}${$("#exportEdition").value === "player" ? "-player" : ""}`;
  if (hasBundledImages(book)) {
    prepareBookZip(book, name);
    return;
  }
  const blob = new Blob([JSON.stringify(book, null, 2)], { type: "application/json" });
  downloadBookFile(blob, `${name}.json`);
}

async function prepareBookZip(book, name) {
  const dialog = $("#bookZipExport");
  const status = $("#bookZipExportStatus");
  const download = $("#downloadBookZip");
  const current = { fileName: `${name}.zip` };
  zipExport = current;
  status.textContent = "Preparing the ZIP…";
  download.disabled = true;
  dialog.showModal();
  try {
    const bundledFiles = new Map([...state.bundledImages].map(([path, image]) => [path, image.blob]));
    const { blob, imageCount } = await window.bookArchive.create(book, (block) => state.previewImages.get(block), bundledFiles);
    if (zipExport !== current || !dialog.open) return;
    current.blob = blob;
    const size = blob.size >= 1024 ** 2 ? `${(blob.size / 1024 ** 2).toFixed(1)} MiB` : `${(blob.size / 1024).toFixed(1)} KiB`;
    status.textContent = `${current.fileName} · ${size} · ${imageCount} bundled image${imageCount === 1 ? "" : "s"}`;
    download.disabled = false;
  } catch (error) {
    if (zipExport === current && dialog.open) status.textContent = `Could not prepare the ZIP. ${error.message}`;
  }
}

function downloadBookZip() {
  if (!zipExport?.blob) return;
  downloadBookFile(zipExport.blob, zipExport.fileName);
  $("#bookZipExport").close();
}

function downloadBookFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`Exported ${fileName}`);
}

function validateBookPackage(bookPackage) {
  if (!bookPackage || bookPackage.format !== "ttrpg-book") throw new Error("The file is not a ttrpg-book package.");
  if (!Number.isInteger(bookPackage.schemaVersion)) throw new Error("The package is missing schemaVersion.");
  if (!bookPackage.book?.title || !Array.isArray(bookPackage.entries) || !Array.isArray(bookPackage.assets)) throw new Error("The package is missing book, entries, or assets.");
  if (typeof bookPackage.book.title !== "string" || typeof bookPackage.book.id !== "string") throw new Error("The book title or ID is invalid.");
  const assets = new Set();
  for (const asset of bookPackage.assets) {
    if (!asset || typeof asset.id !== "string" || typeof asset.src !== "string" || typeof asset.alt !== "string" || assets.has(asset.id)) {
      throw new Error("An image asset has an invalid or duplicate ID, source, or alt text.");
    }
    assets.add(asset.id);
  }
  const entryIds = new Set();
  const strings = (values) => Array.isArray(values) && values.every((value) => typeof value === "string");
  for (const entry of bookPackage.entries) {
    if (!entry || typeof entry.id !== "string" || typeof entry.title !== "string" || !Array.isArray(entry.blocks) || entryIds.has(entry.id)) {
      throw new Error("An entry has an invalid or duplicate ID, title, or content.");
    }
    entryIds.add(entry.id);
    for (const block of entry.blocks) {
      if (!block || typeof block.type !== "string") throw new Error("An entry contains an invalid content block.");
      const textValid = !["heading", "paragraph"].includes(block.type) || typeof block.text === "string";
      const headingValid = block.type !== "heading" || Number.isInteger(block.level) && block.level >= 1 && block.level <= 6;
      const listValid = block.type !== "list" || strings(block.items) && (block.ordered === undefined || typeof block.ordered === "boolean") &&
        (block.start === undefined || Number.isSafeInteger(block.start) && block.start >= 0);
      const tableValid = block.type !== "table" || strings(block.columns) && Array.isArray(block.rows) && block.rows.every(strings);
      const imageValid = block.type !== "image" || assets.has(block.assetId) && [block.caption, block.alt, block.className, block.width]
        .every((value) => value === undefined || typeof value === "string");
      const videoValid = block.type !== "embed" || block.kind !== "video-grid" || typeof block.title === "string" &&
        Array.isArray(block.items) && block.items.every((item) => item && typeof item.url === "string" && typeof item.thumbnail === "string");
      if (!textValid || !headingValid || !listValid || !tableValid || !imageValid || !videoValid) throw new Error(`Invalid content in ${entry.title}.`);
    }
  }
}

function parseMetadata(block) {
  const get = (key) => block.match(new RegExp(`^${key}:\\s*(.*)$`, "mi"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
  return { title: get("title") || "Untitled book", description: get("description"), theme: get("theme") || "Homebrewery" };
}

function listItemText(line) { return line.match(/^(?:[-*+]|\d{1,9}[.)])\s+(\S.*)$/)?.[1] ?? null; }
function isStructuralLine(line) { return /^(#{1,6})\s+/.test(line) || /^!\[/.test(line) || /^\|.*\|$/.test(line) || listItemText(line) !== null || line === "<!--COLUMN_BREAK-->" || /^<div\b/i.test(line) || /^---+$/.test(line); }
function setStatus(message) { $("#sourceStatus").innerHTML = `<i></i> ${escapeHtml(message)}`; }
function showNotice(message) { const notice = $("#notice"); notice.textContent = message; notice.hidden = false; setTimeout(() => { notice.hidden = true; }, 8000); }
function stripMarkup(value) { return unwrapHomebreweryText(value).replace(/[*_`]/g, "").trim(); }
function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function normalizeBreaks(value) { return String(value).replace(/[ \t]*<br[ \t]*\/?[ \t]*>[ \t]*/gi, "\n").replace(/\r\n?/g, "\n"); }
function normalizeBookText(bookPackage, onChange = () => {}) {
  const normalize = (value) => {
    const converted = normalizeBreaks(value);
    if (converted !== value) onChange();
    return converted;
  };
  const field = (object, key) => { if (typeof object[key] === "string") object[key] = normalize(object[key]); };
  field(bookPackage.book, "title");
  field(bookPackage.book, "description");
  for (const asset of bookPackage.assets) field(asset, "alt");
  for (const entry of bookPackage.entries) {
    field(entry, "title");
    for (const block of entry.blocks) {
      for (const key of ["text", "title", "caption", "alt"]) field(block, key);
      if (block.type === "list") block.items = block.items.map(normalize);
      if (block.type === "table") {
        block.columns = block.columns.map(normalize);
        block.rows = block.rows.map((row) => row.map(normalize));
      }
    }
  }
  return bookPackage;
}
function inlineMarkdown(value) { let html = escapeHtml(normalizeBreaks(value)).replace(/`([^`]+)`/g, "<code>$1</code>"); html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>"); return html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1 ↗</a>').replace(/\n/g, "<br>"); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }
