const BOOK_PATH = "books/euphoria-demo/book.json";

const readerState = { bookPackage: null, entries: [], currentEntry: 0, search: "" };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", () => {
  $("#previousButton").addEventListener("click", () => goToEntry(readerState.currentEntry - 1));
  $("#nextButton").addEventListener("click", () => goToEntry(readerState.currentEntry + 1));
  $("#searchInput").addEventListener("input", (event) => { readerState.search = event.target.value.trim().toLowerCase(); renderContents(); });
  $("#jsonInput").addEventListener("change", loadSelectedJson);
  loadDefaultBook();
});

async function loadDefaultBook() {
  try {
    const response = await fetch(BOOK_PATH);
    if (!response.ok) throw new Error("The default book package is unavailable.");
    loadPackage(JSON.parse(await response.text()), "Euphoria Demo book.json");
  } catch (error) {
    setStatus("Open a book JSON package to begin");
    showNotice(error.message);
  }
}

function loadSelectedJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const bookPackage = JSON.parse(String(reader.result));
      validateBookPackage(bookPackage);
      loadPackage(bookPackage, file.name);
    } catch (error) { showNotice(`Could not load this book JSON: ${error.message}`); }
  });
  reader.readAsText(file);
}

function loadPackage(bookPackage, fileName) {
  validateBookPackage(bookPackage);
  readerState.bookPackage = bookPackage;
  readerState.entries = bookPackage.entries;
  readerState.currentEntry = 0;
  applyTheme(bookPackage.theme);
  applyPackageMeta(bookPackage);
  renderContents();
  renderEntry();
  setStatus(`Loaded ${fileName}`);
}

function renderEntry() {
  const entry = readerState.entries[readerState.currentEntry];
  if (!entry || !readerState.bookPackage) return;
  const html = entry.blocks.map((block, blockIndex) => renderBlock(block, readerState.bookPackage.assets, readerState.currentEntry, blockIndex)).join("\n");
  const direction = readerState.bookPackage.book.direction === "rtl" ? "rtl" : "ltr";
  $("#pageViewport").innerHTML = `<article class="book-page" dir="${direction}"><div class="page-inner"><div class="page-content">${html}</div></div><span class="page-number">${String(readerState.currentEntry + 1).padStart(2, "0")}</span></article>`;
  $("#currentPage").textContent = readerState.currentEntry + 1;
  $("#totalPages").textContent = readerState.entries.length;
  $("#currentLabel").textContent = entry.title;
  $("#previousButton").disabled = readerState.currentEntry === 0;
  $("#nextButton").disabled = readerState.currentEntry === readerState.entries.length - 1;
  renderContents();
}

function renderContents() {
  const contents = $("#contents");
  const filtered = readerState.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !readerState.search || `${entry.title} ${JSON.stringify(entry.blocks)}`.toLowerCase().includes(readerState.search));
  contents.innerHTML = filtered.map(({ entry, index }) => {
    const active = index === readerState.currentEntry;
    const subsections = active ? entry.blocks.map((block, blockIndex) => ({ block, blockIndex })).filter(({ block }) => block.type === "heading" && Number(block.level) === 3) : [];
    const subitems = subsections.length ? `<div class="contents-subtree" role="group" aria-label="${escapeAttribute(entry.title)} sections">${subsections.map(({ block, blockIndex }) => `<a class="contents-subitem" data-section="entry-${index}-section-${blockIndex}" href="#entry-${index}-section-${blockIndex}"><span class="page-no">H3</span><span class="page-title">${inlineMarkdown(block.text)}</span></a>`).join("")}</div>` : "";
    return `<div class="contents-entry"><button type="button" class="${active ? "active" : ""}"${active ? ' aria-current="page"' : ""} data-entry="${index}"><span class="page-no">H2</span><span class="page-title">${escapeHtml(entry.title)}</span></button>${subitems}</div>`;
  }).join("") || '<p class="empty-search">No matching entries.</p>';
  contents.querySelectorAll("button[data-entry]").forEach((button) => button.addEventListener("click", () => goToEntry(Number(button.dataset.entry))));
  contents.querySelectorAll("a[data-section]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById(link.dataset.section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#contentsCount").textContent = `${filtered.length}/${readerState.entries.length}`;
}

function goToEntry(index) {
  if (index < 0 || index >= readerState.entries.length) return;
  readerState.currentEntry = index;
  renderEntry();
  $(".reader-stage").scrollTo({ top: 0, behavior: "smooth" });
}

function renderBlock(block, assets, entryIndex, blockIndex) {
  if (block.type === "heading") { const level = Math.min(Math.max(block.level, 2), 5); const id = level === 3 ? ` id="entry-${entryIndex}-section-${blockIndex}"` : ""; return `<h${level}${id}>${inlineMarkdown(block.text)}</h${level}>`; }
  if (block.type === "paragraph") return `<p${block.style ? ` class="${escapeAttribute(block.style)}"` : ""}>${inlineMarkdown(block.text)}</p>`;
  if (block.type === "list") return `<ul>${block.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`;
  if (block.type === "table") return `<table><thead><tr>${block.columns.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  if (block.type === "divider") return `<div class="column-marker" aria-hidden="true"></div>`;
  if (block.type === "image") {
    const asset = assets.find((candidate) => candidate.id === block.assetId);
    if (!asset) return "";
    const semanticClass = block.role === "emblem" ? " entry-emblem" : "";
    const placementClass = block.placement === "entry-top-right" ? " entry-emblem--top-right" : "";
    const customClass = block.className ? ` ${block.className.replace(/[^a-z0-9_-]/gi, "")}` : "";
    const className = `${semanticClass}${placementClass}${customClass}`;
    const width = block.width ? ` style="width:${escapeAttribute(block.width)}"` : "";
    return `<figure class="page-art page-art--flow${className}"${width}><span class="image-frame"><img src="${escapeAttribute(asset.src)}" alt="${escapeAttribute(asset.alt)}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(asset.alt)}" data-image-viewer tabindex="0" loading="lazy"></span><figcaption>${inlineMarkdown(asset.alt)}</figcaption></figure>`;
  }
  if (block.type === "embed" && block.kind === "video-grid") return `<section><h3>${inlineMarkdown(block.title)}</h3><div class="video-grid">${block.items.map((item, index) => `<a class="video-card" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer"><span class="image-frame image-frame--wide"><img src="${escapeAttribute(item.thumbnail)}" alt="${escapeAttribute(block.title)} video ${index + 1}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(block.title)} video ${index + 1}" data-image-viewer tabindex="0" loading="lazy"></span><span class="video-card-caption">Watch ${escapeHtml(block.title)} video ${index + 1} ↗</span></a>`).join("")}</div></section>`;
  return "";
}

function applyPackageMeta(bookPackage) {
  const blockCount = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.length, 0);
  $("#bookTitle").textContent = bookPackage.book.title;
  $("#bookDescription").textContent = bookPackage.book.description || "Reader-ready TTRPG book.";
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
}

function inlineMarkdown(value) { let html = escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>"); html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>"); return html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1 ↗</a>'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }
function setStatus(message) { $("#sourceStatus").innerHTML = `<i></i> ${escapeHtml(message)}`; }
function showNotice(message) { const notice = $("#notice"); notice.textContent = message; notice.hidden = false; setTimeout(() => { notice.hidden = true; }, 8000); }
