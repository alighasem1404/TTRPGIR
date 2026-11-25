// Build the contents in document order, keeping H1 parts separate from clickable entries.
function bookContentsRows(entries, search = "", visible = () => true) {
  const rows = [];
  let part = null;

  for (const [index, entry] of entries.entries()) {
    const blocks = entry.blocks;
    const lead = blocks.findIndex((block) => !block.statBlock && block.type === "heading" && block.level === 2);
    const entryPosition = lead < 0 ? blocks.findIndex((block) => block.statBlock || block.type !== "heading" || block.level !== 1) : lead;
    const addPart = (block) => {
      if (block.statBlock || block.type !== "heading" || block.level !== 1 || !visible(block)) return;
      const title = normalizeBreaks(block.text);
      part = { type: "part", title, matched: !search || title.toLowerCase().includes(search) };
      rows.push(part);
    };
    const before = entryPosition < 0 ? blocks.length : entryPosition;
    blocks.slice(0, before).forEach(addPart);
    if (entryPosition >= 0 || !blocks.length) {
      const searchableBlocks = blocks.filter((block) => visible(block) && !(!block.statBlock && block.type === "heading" && block.level === 1));
      const matched = !search || `${entry.title} ${JSON.stringify(searchableBlocks)}`.toLowerCase().includes(search) || part?.title.toLowerCase().includes(search);
      rows.push({ type: "entry", entry, index, part, matched });
      if (matched && part) part.matched = true;
    }
    blocks.slice(before).forEach(addPart);
  }

  return rows;
}

function renderBookContents(entries, current, search, entryAttribute, navigate, visible = () => true) {
  const contents = document.getElementById("contents");
  const rows = bookContentsRows(entries, search, visible);
  const filtered = rows.filter((row) => row.matched);
  contents.innerHTML = filtered.map((row) => {
    if (row.type === "part") {
      return `<div class="contents-part" role="heading" aria-level="1"><span class="page-no">H1</span><span class="page-title">${escapeHtml(normalizeBreaks(row.title)).replace(/\n/g, "<br>")}</span></div>`;
    }
    const { entry, index, part } = row;
    const active = index === current;
    const subsections = active ? entry.blocks.map((block, blockIndex) => ({ block, blockIndex })).filter(({ block }) => visible(block) && !block.statBlock && block.type === "heading" && Number(block.level) === 3) : [];
    const subitems = subsections.length ? `<div class="contents-subtree" role="group" aria-label="${escapeAttribute(entry.title)} sections">${subsections.map(({ block, blockIndex }) => `<a class="contents-subitem" data-section="entry-${index}-section-${blockIndex}" href="#entry-${index}-section-${blockIndex}"><span class="page-no">H3</span><span class="page-title">${inlineMarkdown(block.text)}</span></a>`).join("")}</div>` : "";
    return `<div class="contents-entry${part ? " contents-entry--part" : ""}"><button type="button" class="${active ? "active" : ""}"${active ? ' aria-current="page"' : ""} ${entryAttribute}="${index}"><span class="page-no">H2</span><span class="page-title">${escapeHtml(normalizeBreaks(entry.title)).replace(/\n/g, "<br>")}</span></button>${subitems}</div>`;
  }).join("") || '<p class="empty-search">No matching entries.</p>';
  contents.querySelectorAll(`button[${entryAttribute}]`).forEach((button) => button.addEventListener("click", () => navigate(Number(button.getAttribute(entryAttribute)))));
  contents.querySelectorAll("a[data-section]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById(link.dataset.section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.getElementById("contentsCount").textContent = `${filtered.filter((row) => row.type === "entry").length}/${rows.filter((row) => row.type === "entry").length}`;
}


// A stat block stays a group of normal, individually editable content blocks.
// The shared renderer groups consecutive members without changing their indices.
function renderStatBlocks(blocks, renderBlock) {
  const html = [];
  for (let index = 0; index < blocks.length;) {
    const group = blocks[index].statBlock;
    if (!group) { html.push(renderBlock(blocks[index], index)); index += 1; continue; }
    const start = index;
    while (index < blocks.length && blocks[index].statBlock === group) index += 1;
    const title = blocks.slice(start, index).find((block) => block.type === "heading")?.text || "Stat block";
    const content = [];
    for (let at = start; at < index;) {
      if (blocks[at].type !== "table") { content.push(renderBlock(blocks[at], at)); at += 1; continue; }
      const tables = [];
      while (at < index && blocks[at].type === "table") { tables.push(renderBlock(blocks[at], at)); at += 1; }
      const visible = tables.filter(Boolean);
      content.push(visible.length > 1 ? `<div class="stat-block-tables">${visible.join("")}</div>` : visible.join(""));
    }
    if (content.some(Boolean)) html.push(`<section class="stat-block" data-stat-block="${escapeAttribute(group)}" aria-label="${escapeAttribute(title)}">${content.join("\n")}</section>`);
  }
  return html.join("\n");
}


// Older exports collapsed Homebrewery stat rows into spaces and retained
// double-colon notation. Recover the visual rows without rewriting saved text.
function statBlockText(value) {
  return normalizeBreaks(value)
    .replace(/(^|[ \t]+)(\*\*[^*\n]+\*\*)[ \t]*::[ \t]*/gm, (_, space, label) => `${space ? "\n" : ""}${label}: `)
    .replace(/[ \t]*::[ \t]*(?=\*\*[^*\n]+\*\*)/g, "\n")
    .replace(/[ \t]*::[ \t]*$/gm, "")
    .replace(/[ \t]+(?=\*\*(?:At Will|\d+\/(?:Day|Rest)(?: Each)?):\*\*)/gi, "\n");
}
