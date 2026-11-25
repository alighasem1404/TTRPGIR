const BOOK_PATH = "books/euphoria-demo/book.json";

const readerState = { bookPackage: null, entries: [], currentEntry: 0, search: "", bundledImages: new Map() };
const $ = (selector) => document.querySelector(selector);
let bookRequest;

document.addEventListener("DOMContentLoaded", () => {
  $("#previousButton").addEventListener("click", () => goToEntry(readerState.currentEntry - 1));
  $("#nextButton").addEventListener("click", () => goToEntry(readerState.currentEntry + 1));
  $("#searchInput").addEventListener("input", (event) => { readerState.search = event.target.value.trim().toLowerCase(); renderContents(); });
  $("#jsonInput").addEventListener("change", loadSelectedBook);
  loadDefaultBook();
});

async function loadDefaultBook() {
  const request = new AbortController();
  bookRequest = request;
  try {
    const response = await fetch(BOOK_PATH, { signal: request.signal });
    if (!response.ok) throw new Error("The default book package is unavailable.");
    const bookPackage = await response.json();
    request.signal.throwIfAborted();
    loadPackage(bookPackage, "Euphoria Demo book.json");
  } catch (error) {
    if (request.signal.aborted) return;
    setStatus("Open a book ZIP or JSON package to begin");
    showNotice(error.message);
  }
}

async function loadSelectedBook(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = "";
  bookRequest?.abort();
  const request = new AbortController();
  bookRequest = request;
  try {
    const { bookPackage, images } = /\.zip$/i.test(file.name)
      ? await window.bookArchive.open(file, validateBookPackage, request.signal)
      : { bookPackage: JSON.parse(await file.text()) };
    request.signal.throwIfAborted();
    loadPackage(bookPackage, file.name, images);
  } catch (error) {
    if (!request.signal.aborted) showNotice(`Could not open ${file.name}. ${error.message}`);
  }
}

function loadPackage(bookPackage, fileName, images = new Map()) {
  validateBookPackage(bookPackage);
  const previousImages = readerState.bundledImages;
  readerState.bundledImages = new Map([...images].map(([path, blob]) => [path, URL.createObjectURL(blob)]));
  readerState.bookPackage = bookPackage;
  readerState.entries = bookPackage.entries;
  readerState.currentEntry = 0;
  applyTheme(bookPackage.theme);
  applyPackageMeta(bookPackage);
  renderContents();
  renderEntry();
  for (const url of previousImages.values()) URL.revokeObjectURL(url);
  setStatus(`Loaded ${fileName}`);
}

function renderEntry() {
  const entry = readerState.entries[readerState.currentEntry];
  if (!readerState.bookPackage) return;
  if (!entry) {
    $("#pageViewport").replaceChildren();
    $("#currentPage").textContent = "0";
    $("#totalPages").textContent = "0";
    $("#currentLabel").textContent = "No entries";
    $("#previousButton").disabled = $("#nextButton").disabled = true;
    renderContents();
    return;
  }
  const html = entry.blocks.map((block, blockIndex) => renderBlock(block, readerState.bookPackage.assets, readerState.currentEntry, blockIndex)).join("\n");
  const direction = readerState.bookPackage.book.direction === "rtl" ? "rtl" : "ltr";
  $("#pageViewport").innerHTML = `<article class="book-page" dir="${direction}"><div class="page-inner"><div class="page-content">${html}</div></div></article>`;
  $("#currentPage").textContent = readerState.currentEntry + 1;
  $("#totalPages").textContent = readerState.entries.length;
  $("#currentLabel").textContent = normalizeBreaks(entry.title);
  $("#previousButton").disabled = readerState.currentEntry === 0;
  $("#nextButton").disabled = readerState.currentEntry === readerState.entries.length - 1;
  renderContents();
}

function renderContents() {
  renderBookContents(readerState.entries, readerState.currentEntry, readerState.search, "data-entry", goToEntry);
}

function goToEntry(index) {
  if (index < 0 || index >= readerState.entries.length) return;
  readerState.currentEntry = index;
  renderEntry();
  $(".reader-stage").scrollTo({ top: 0, behavior: "smooth" });
}

function renderBlock(block, assets, entryIndex, blockIndex) {
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
    const original = assets.find((candidate) => candidate.id === block.assetId);
    if (!original) return "";
    const asset = { ...original, src: readerState.bundledImages.get(original.src) || original.src };
    const semanticClass = block.role === "emblem" ? " entry-emblem" : "";
    const placementClass = block.placement === "entry-top-right" ? " entry-emblem--top-right" : "";
    const customClass = block.className ? ` ${block.className.replace(/[^a-z0-9_-]/gi, "")}` : "";
    const className = `${semanticClass}${placementClass}${customClass}`;
    const width = block.width ? ` style="width:${escapeAttribute(block.width)}"` : "";
    const alt = block.alt ?? asset.alt;
    const caption = block.caption ?? asset.alt;
    return `<figure class="page-art page-art--flow${className}"${width}><span class="image-frame"><img src="${escapeAttribute(asset.src)}" alt="${escapeAttribute(alt)}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(alt)}" data-image-viewer tabindex="0" loading="lazy"></span>${caption ? `<figcaption>${inlineMarkdown(caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.type === "embed" && block.kind === "video-grid") return `<section><h3>${inlineMarkdown(block.title)}</h3><div class="video-grid">${block.items.map((item, index) => `<a class="video-card" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer"><span class="image-frame image-frame--wide"><img src="${escapeAttribute(item.thumbnail)}" alt="${escapeAttribute(block.title)} video ${index + 1}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(block.title)} video ${index + 1}" data-image-viewer tabindex="0" loading="lazy"></span><span class="video-card-caption">Watch ${escapeHtml(block.title)} video ${index + 1} ↗</span></a>`).join("")}</div></section>`;
  return "";
}

function applyPackageMeta(bookPackage) {
  const blockCount = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.length, 0);
  $("#bookTitle").textContent = normalizeBreaks(bookPackage.book.title);
  $("#bookDescription").textContent = normalizeBreaks(bookPackage.book.description || "Reader-ready TTRPG book.");
  $("#themeLabel").textContent = `JSON v${bookPackage.schemaVersion}`;
  $("#pageCount").textContent = `${bookPackage.entries.length} entries`;
  $("#statPages").textContent = bookPackage.entries.length;
  $("#statImages").textContent = bookPackage.assets.filter((asset) => !asset.ignored).length;
  $("#statTables").textContent = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.filter((block) => block.type === "table").length, 0);
  $("#statDirectives").textContent = blockCount;
  applyBookLocale(bookPackage.book);
  document.title = `${bookPackage.book.title} · Book Reader`;
}

function applyBookLocale(book) {
  const language = book.language || "en";
  const direction = book.direction || "ltr";
  document.documentElement.lang = language;
  $("#pageViewport").lang = language;
  $("#pageViewport").dir = direction;
  $("#bookTitle").dir = direction;
  $("#bookDescription").dir = direction;
  $("#contents").dir = direction;
  $("#currentLabel").dir = direction;
  $(".page-controls").dir = direction;
  $("#previousButton").textContent = direction === "rtl" ? "→" : "←";
  $("#nextButton").textContent = direction === "rtl" ? "←" : "→";
}

function applyTheme(theme = {}) {
  const root = document.documentElement;
  const aliases = { "color.background": "--parchment", "color.backgroundLight": "--parchment-light", "color.surface": "--card", "color.primary": "--wine", "color.primaryDark": "--wine-dark", "color.accent": "--gold", "color.accentLight": "--gold-light", "color.accentDark": "--gold-dark", "color.secondary": "--plum", "color.text": "--ink", "color.textMuted": "--ink-soft", "color.border": "--border", "color.hover": "--hover", "font.body": "--book-body-font", "font.ui": "--book-ui-font" };
  Object.entries(theme.tokens || {}).forEach(([token, value]) => { if (aliases[token]) root.style.setProperty(aliases[token], value); });
}

function validateBookPackage(bookPackage) {
  if (!bookPackage || bookPackage.format !== "ttrpg-book") throw new Error("The file is not a ttrpg-book package.");
  if (!Number.isInteger(bookPackage.schemaVersion)) throw new Error("The package is missing schemaVersion.");
  if (!bookPackage.book?.title || !Array.isArray(bookPackage.entries) || !Array.isArray(bookPackage.assets)) throw new Error("The package is missing book, entries, or assets.");
  if (bookPackage.assets.some((asset) => !asset || typeof asset.id !== "string" || typeof asset.src !== "string")) {
    throw new Error("A book asset has an invalid ID or source.");
  }
  if (bookPackage.entries.some((entry) => !entry || !Array.isArray(entry.blocks) || entry.blocks.some((block) => !isReadableBlock(block)))) {
    throw new Error("A book entry contains invalid content blocks.");
  }
}

function isReadableBlock(block) {
  if (!block || typeof block.type !== "string") return false;
  if (block.type === "image") return [block.className, block.alt, block.caption].every((value) => value === undefined || typeof value === "string");
  if (block.type === "list") return Array.isArray(block.items);
  if (block.type === "table") return Array.isArray(block.columns) && Array.isArray(block.rows) && block.rows.every(Array.isArray);
  if (block.type === "embed" && block.kind === "video-grid") return Array.isArray(block.items) && block.items.every((item) => item && typeof item === "object");
  return true;
}

function normalizeBreaks(value) { return String(value).replace(/[ \t]*<br[ \t]*\/?[ \t]*>[ \t]*/gi, "\n").replace(/\r\n?/g, "\n"); }
function inlineMarkdown(value) { let html = escapeHtml(normalizeBreaks(value)).replace(/`([^`]+)`/g, "<code>$1</code>"); html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>"); return html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1 ↗</a>').replace(/\n/g, "<br>"); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }
function setStatus(message) { $("#sourceStatus").innerHTML = `<i></i> ${escapeHtml(message)}`; }
function showNotice(message) { const notice = $("#notice"); notice.textContent = message; notice.hidden = false; setTimeout(() => { notice.hidden = true; }, 8000); }
