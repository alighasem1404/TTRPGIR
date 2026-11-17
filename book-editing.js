(() => {
  const dialog = $("#bookEditing");
  const form = $("#bookEditingForm");
  const fields = $("#bookEditingFields");
  const message = $("#bookEditingStatus");
  const toggle = $("#toggleBookEditing");
  let action;
  let order;
  let hiddenSections;
  let active = false;
  let releaseImagePreview;

  window.bookEditing = { reset, wrapBlock, exportPackage, get active() { return active; } };
  reset();
  toggle.addEventListener("click", () => {
    active = !active;
    toggle.setAttribute("aria-pressed", String(active));
    toggle.textContent = active ? "Done editing" : "Edit preview";
    renderPage();
  });
  $("#pageViewport").addEventListener("click", (event) => {
    const button = event.target.closest("[data-book-edit], [data-book-add]");
    if (button) {
      const { bookEdit, bookAdd } = button.dataset;
      const index = Number(bookEdit ?? bookAdd);
      if (bookEdit !== undefined && currentEntry().blocks[index]?.type === "image") editImage(index);
      else editText(index, bookEdit === undefined);
      return;
    }
    if (!active || event.target.closest("a, button, input")) return;
    const card = event.target.closest("[data-edit-block]");
    if (card) {
      event.stopPropagation();
      card.querySelector("[data-book-edit]")?.click();
    }
  });
  $("#organizeBook").addEventListener("click", organizeBook);
  $("#editSectionRules").addEventListener("click", editSectionRules);
  $("#reviewSourceItems").addEventListener("click", reviewSourceItems);
  $("#exportEdition").addEventListener("change", updateExportLabel);
  dialog.addEventListener("close", () => { if (!dialog.open) releaseImagePreview?.(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = action;
    const button = event.submitter || form.querySelector('button[type="submit"]');
    if (!current || !button || button.disabled) return;
    button.disabled = true;
    message.textContent = "";
    try {
      await current(button.value, () => action === current && dialog.open);
    } catch (error) {
      if (action === current && dialog.open) message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function reset() {
    action = null;
    if (dialog.open) dialog.close();
    active = false;
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "Edit preview";
    order = [];
    hiddenSections = new Set();
    $("#exportEdition").value = "full";
  }

  function currentEntry() { return state.entries[state.currentPage]; }

  function open(title, html, apply) {
    releaseImagePreview?.();
    releaseImagePreview = null;
    $("#bookEditingTitle").textContent = title;
    fields.innerHTML = html;
    message.textContent = "";
    action = apply;
    if (!dialog.open) dialog.showModal();
  }

  function save(entries, notice) {
    dialog.close();
    applyEditedEntries(entries, { keepHeadingHistory: false });
    showNotice(notice);
  }

  function wrapBlock(block, index, content) {
    const editable = ["paragraph", "heading", "image"].includes(block.type);
    const label = block.type === "image" ? "Edit image" : block.type === "heading" ? "Edit heading" : "Edit text";
    const control = editable ? `<button type="button" data-book-edit="${index}">${label}</button>` : "";
    return `<div class="book-edit-block"${editable ? ` data-edit-block="${index}"` : ""}>${content}<div class="book-block-actions">${control}<button type="button" data-book-add="${index + 1}">Add below</button></div></div>`;
  }

  function withBlocks(entry, blocks) {
    return state.entries.map((candidate) => candidate === entry ? { ...entry, blocks } : candidate);
  }

  function displayOptions(options, selected) {
    return options.map(([value, label]) => `<option value="${escapeAttribute(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  function editText(index, add) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const format = block?.type === "heading" ? `h${block.level}` : block?.style || "paragraph";
    const isSection = block?.type === "heading" && block.level === 3;
    const formats = [["paragraph", "Paragraph"], ["book-quote", "Quote"], ["book-callout", "Callout"],
      ...[1, 2, 3, 4, 5, 6].map((level) => [`h${level}`, `Heading H${level}`])];
    if (!formats.some(([value]) => value === format)) formats.push([format, "Current style"]);
    if (add) formats.push(["image", "Image"]);
    const otherEntries = state.entries.filter((item) => item !== entry).map(({ id, title }) => [id, title]);
    open(add ? "Add a block" : "Edit preview block", `
      <label>Format <select name="format">${displayOptions(formats, format)}</select></label>
      <label id="editTextField">Text <textarea name="text" rows="6" dir="auto" required>${escapeHtml(block?.text || "")}</textarea></label>
      ${isSection ? `<label>Player edition <select name="visibility">${displayOptions([["default", "Follow section rule"], ["include", "Include this section"], ["exclude", "Hide this section"]], block[sectionVisibility] || "default")}</select></label>
        ${otherEntries.length ? `<label>Move section to <select name="destination">${displayOptions([["", "Keep in this entry"], ...otherEntries], "")}</select></label>` : ""}` : ""}
      <div class="book-edit-actions">
        <button type="submit" value="save">${add ? "Add block" : "Save edits"}</button>
        ${block?.type === "paragraph" ? '<button type="submit" value="selection">Format selected text</button>' : ""}
        ${!add ? '<button type="submit" value="remove" formnovalidate>Remove block</button>' : ""}
      </div>`, (command) => {
      const selected = form.elements.format.value;
      if (selected === "image") { editImage(index, true); return; }
      const textField = form.elements.text;
      const value = textField.value;
      if (command !== "remove" && !value.trim()) throw new Error("Enter some text.");
      const makeBlock = (text, type) => /^h[1-6]$/.test(type)
        ? { type: "heading", level: Number(type[1]), text: text.trim().replace(/\s*\n\s*/g, " ") }
        : { type: "paragraph", text: text.trim(), ...(type !== "paragraph" && { style: type }) };
      let replacement = [];
      if (command === "selection") {
        const { selectionStart: start, selectionEnd: end } = textField;
        if (!value.slice(start, end).trim()) throw new Error("Select the words to format in the text field.");
        replacement = [value.slice(0, start), value.slice(start, end), value.slice(end)]
          .flatMap((part, partIndex) => part.trim() ? [makeBlock(part, partIndex === 1 ? selected : format)] : []);
      } else if (command !== "remove") {
        replacement = /^h/.test(selected) ? [makeBlock(value, selected)]
          : value.split(/\n\s*\n/).map((text) => makeBlock(text, selected)).filter(({ text }) => text);
      }
      const visibility = form.elements.visibility?.value;
      if (visibility && replacement[0]?.level === 3) replacement[0][sectionVisibility] = visibility;
      if (block?.[sourceHeadingKey] && replacement[0]?.type === "heading") replacement[0][sourceHeadingKey] = block[sourceHeadingKey];
      if (block?.[sourceArtifact] && replacement.length) replacement[0][sourceArtifact] = block[sourceArtifact];
      const destination = form.elements.destination?.value;
      if (command === "save" && destination) {
        if (replacement[0]?.level !== 3) throw new Error("Keep H3 to move the whole section.");
        const end = sectionEnd(entry.blocks, index);
        const moving = [...replacement, ...entry.blocks.slice(index + 1, end)];
        save(state.entries.map((item) => item === entry
          ? { ...item, blocks: [...item.blocks.slice(0, index), ...item.blocks.slice(end)] }
          : item.id === destination ? { ...item, blocks: [...item.blocks, ...moving] } : item), "Section moved.");
        return;
      }
      const blocks = [...entry.blocks];
      blocks.splice(index, add ? 0 : 1, ...replacement);
      let entries = withBlocks(entry, blocks);
      const entryLevel = entryHeadingLevel(state.config);
      if (command === "save" && block?.type === "heading" && replacement[0]?.type === "heading" &&
        (block.level === entryLevel || replacement[0].level === entryLevel)) {
        const edit = { title: replacement[0].text, level: replacement[0].level };
        entries = regroupEditedHeadings(new Map([[block, edit]]));
      } else {
        const newEntryHeading = replacement.find((part) => part.type === "heading" && part.level === entryLevel);
        if (newEntryHeading) {
          newEntryHeading.level = entryLevel === 1 ? 2 : 1;
          entries = regroupEditedHeadings(new Map([[newEntryHeading, { title: newEntryHeading.text, level: entryLevel }]]), entries);
        }
      }
      save(entries, "Preview updated.");
    });
    const selector = form.elements.format;
    selector.addEventListener("change", () => {
      const image = selector.value === "image";
      $("#editTextField").hidden = image;
      form.elements.text.required = !image;
    });
  }

  function editImage(index, add = false) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const asset = state.bookPackage.assets.find(({ id }) => id === block?.assetId);
    const recovered = block && state.previewImages.get(block);
    const defaultAlt = recovered?.caption ?? asset?.alt ?? "";
    const imageSource = recovered?.url || asset?.src || "";
    const editableUrl = recovered ? "" : asset?.src || "";
    const width = /^\d+(?:\.\d+)?%$/.test(block?.width || "") ? block.width.slice(0, -1) : "";
    open(add ? "Add an image" : "Edit image", `
      <div class="book-edit-grid">
        <label>Image URL <input name="url" value="${escapeAttribute(editableUrl)}" placeholder="https://…" spellcheck="false"></label>
        <label>Upload replacement <input name="upload" type="file" accept="image/*"></label>
        <label>PNG filename <input name="fileName" value="${escapeAttribute(recovered?.fileName || "")}" placeholder="Enter a name to bundle the image"></label>
        <label>Width (%) <input name="width" type="number" min="1" max="100" step="any" value="${width}"></label>
        <label>Caption <input name="caption" dir="auto" value="${escapeAttribute(recovered?.caption ?? block?.caption ?? defaultAlt)}"></label>
        <label>Alt text <input name="alt" dir="auto" value="${escapeAttribute(block?.alt ?? defaultAlt)}"></label>
        <label>Position <select name="position">${displayOptions([["same", "Keep position"], ["above", "Move up one block"], ["below", "Move down one block"], ["top", "Start of entry"], ["bottom", "End of entry"]], "same")}</select></label>
      </div>
      <details><summary>Crop image</summary><label class="book-edit-check"><input type="checkbox" name="crop"> Apply crop on save</label>
        <p>Drag over the image or enter percentages measured from its top-left corner.</p>
        <div id="editCropStage" class="book-crop-stage" hidden><img id="editCropImage" alt="Image to crop" draggable="false"><div id="editCropOutline" hidden></div></div>
        <div class="book-edit-grid">${[["x", "Left", 0], ["y", "Top", 0], ["w", "Width", 100], ["h", "Height", 100]].map(([name, label, value]) => `<label>${label} (%) <input name="${name}" type="number" min="0" max="100" step="any" value="${value}"></label>`).join("")}</div>
      </details>
      <div class="book-edit-actions"><button type="submit" value="save">${add ? "Add image" : "Save image"}</button>${add ? "" : '<button type="submit" value="remove" formnovalidate>Remove image</button>'}</div>`, async (command, isCurrent) => {
      const blocks = [...entry.blocks];
      if (command === "remove") {
        blocks.splice(index, 1);
        save(withBlocks(entry, blocks), "Image removed.");
        return;
      }
      const input = form.elements;
      const url = input.url.value.trim();
      const file = input.upload.files[0];
      const crop = input.crop.checked ? [input.x, input.y, input.w, input.h].map((field) => field.valueAsNumber) : null;
      if (crop && (crop.some((number) => !Number.isFinite(number)) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 100.000001 || crop[1] + crop[3] > 100.000001)) {
        throw new Error("The crop must stay inside the image and have a positive width and height.");
      }
      if (url && url !== editableUrl && !validImageUrl(url)) throw new Error("Enter a web or relative image URL.");
      if (!url && !file && !recovered) throw new Error("Enter an image URL or choose a file.");
      const alt = input.alt.value.trim();
      const caption = input.caption.value.trim();
      const role = block?.role || imageRole(alt);
      const newWidth = input.width.value ? `${input.width.value}%` : width ? undefined : block?.width;
      const position = input.position.value;
      const enteredName = input.fileName.value.trim();
      const requestedName = enteredName || file?.name || recovered?.fileName || alt || "image";
      const bundleLink = url && enteredName && enteredName !== recovered?.fileName;
      const blob = file || crop || bundleLink ? await makeImagePng(file || (url && url !== editableUrl ? url : imageSource || url), crop)
        : !url && recovered ? recovered.blob : null;
      if (!isCurrent()) return;
      const image = { ...block, type: "image", role, placement: position === "same" ? block?.placement || "inline" : "inline", width: newWidth, caption, alt };
      if (position !== "same") delete image.className;
      if (add || url && url !== editableUrl) image.assetId = ensureAsset(url || "about:blank", alt, role);
      const oldKey = block?.[imageSlotContext]?.key;
      const context = image[imageSlotContext] ||= { key: `edited-image-${++editedImageId}`, page: null, before: "", after: "", caption: "" };
      if (blob) {
        const fileName = pngName(requestedName, oldKey);
        if (recovered) URL.revokeObjectURL(recovered.url);
        state.recoveredImages.set(context.key, { ...recovered, blob, fileName, caption, url: URL.createObjectURL(blob) });
      } else if (recovered) {
        URL.revokeObjectURL(recovered.url);
        state.recoveredImages.delete(context.key);
      }
      if (!add) blocks.splice(index, 1);
      const first = blocks[0]?.type === "heading" && blocks[0].level === entryHeadingLevel(state.config) ? 1 : 0;
      const positions = { same: index, above: Math.max(first, index - 1), below: index + 1, top: first, bottom: blocks.length };
      blocks.splice(positions[position], 0, image);
      save(withBlocks(entry, blocks), "Image updated.");
    });
    wireCropPreview(imageSource, editableUrl);
  }

  function wireCropPreview(source, originalUrl) {
    const controls = form.elements;
    const stage = $("#editCropStage");
    const image = $("#editCropImage");
    const outline = $("#editCropOutline");
    const bounds = [controls.x, controls.y, controls.w, controls.h];
    let temporary;
    let start;
    releaseImagePreview = () => {
      if (temporary) URL.revokeObjectURL(temporary);
      temporary = null;
    };
    function showImage() {
      releaseImagePreview();
      const file = controls.upload.files[0];
      if (file) temporary = URL.createObjectURL(file);
      const url = controls.url.value.trim();
      const preview = temporary || (url === originalUrl || !url ? source : validImageUrl(url) ? url : "");
      stage.hidden = !preview;
      if (preview) image.src = preview;
      else image.removeAttribute("src");
    }
    function showOutline() {
      outline.hidden = !controls.crop.checked;
      for (const [index, property] of ["left", "top", "width", "height"].entries()) {
        outline.style[property] = `${bounds[index].valueAsNumber || 0}%`;
      }
    }
    function point(event) {
      const rect = image.getBoundingClientRect();
      const percent = (value, size) => Math.min(100, Math.max(0, 100 * value / size));
      return [percent(event.clientX - rect.left, rect.width), percent(event.clientY - rect.top, rect.height)];
    }
    controls.upload.addEventListener("change", showImage);
    controls.url.addEventListener("change", showImage);
    controls.crop.addEventListener("change", showOutline);
    for (const field of bounds) field.addEventListener("input", showOutline);
    image.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || !image.naturalWidth) return;
      start = point(event);
      image.setPointerCapture(event.pointerId);
    });
    image.addEventListener("pointermove", (event) => {
      if (!start || !image.hasPointerCapture(event.pointerId)) return;
      const [x, y] = point(event);
      const round = (number) => Math.round(number * 100) / 100;
      const left = round(Math.min(x, start[0]));
      const top = round(Math.min(y, start[1]));
      const width = round(Math.max(x, start[0]) - left);
      const height = round(Math.max(y, start[1]) - top);
      if (!width || !height) return;
      [left, top, width, height].forEach((value, index) => { bounds[index].value = value; });
      controls.crop.checked = true;
      showOutline();
    });
    image.addEventListener("lostpointercapture", () => { start = null; });
    showImage();
  }

  function validImageUrl(value) {
    try { return ["http:", "https:", "file:"].includes(new URL(value, document.baseURI).protocol); }
    catch { return false; }
  }

  async function makeImagePng(source, crop) {
    let image;
    let temporary;
    try {
      if (source instanceof Blob) {
        temporary = URL.createObjectURL(source);
        source = temporary;
      }
      image = new Image();
      if (!temporary && /^https?:/.test(new URL(source, document.baseURI).protocol)) image.crossOrigin = "anonymous";
      image.src = source;
      await image.decode();
      const [x, y, w, h] = crop || [0, 0, 100, 100];
      const [left, top, width, height] = [x * image.naturalWidth / 100, y * image.naturalHeight / 100,
        w * image.naturalWidth / 100, h * image.naturalHeight / 100];
      const scale = Math.min(1, 4096 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(image, left, top, width, height, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create a PNG.")), "image/png"));
    } catch {
      throw new Error("Could not read this image for cropping or export. Upload the image file if the host blocks access.");
    } finally {
      if (temporary) URL.revokeObjectURL(temporary);
    }
  }

  function ensureAsset(src, alt, role) {
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    const id = getAssetId(alt, src, assets);
    if (assets.size > state.bookPackage.assets.length) state.bookPackage.assets.push({ ...assets.get(id), role });
    return id;
  }

  function pngName(value, except) {
    const { uniquePngName, reservedImagePaths } = window.bookArchive;
    const used = new Set([...reservedImagePaths(state.bookPackage.assets)].map((path) => path.slice("images/".length)));
    for (const [key, image] of state.recoveredImages) if (key !== except) used.add(image.fileName.toLowerCase());
    return uniquePngName(value, used) || uniquePngName("image", used);
  }

  function sectionEnd(blocks, index) {
    let end = index + 1;
    while (end < blocks.length && !(blocks[end].type === "heading" && blocks[end].level <= 3)) end += 1;
    return end;
  }

  function splitSections(blocks) {
    const parts = [];
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index];
      const section = block.type === "heading" && block.level === 3;
      const end = section ? sectionEnd(blocks, index) : index + 1;
      parts.push({ title: section ? block.text : "", blocks: blocks.slice(index, end) });
      index = end;
    }
    return parts;
  }

  function orderSections(parts, ordered) {
    let cursor = 0;
    return parts.flatMap((part) => part.title ? ordered[cursor++].blocks : part.blocks);
  }

  function organizeBook() {
    if (!currentEntry()) return;
    const entry = currentEntry();
    const entries = [...state.entries];
    const parts = splitSections(entry.blocks);
    const sections = parts.filter((part) => part.title);
    let scope = "entries";
    open("Organize book", `
      <label>Reorder <select name="scope"><option value="entries">Book entries</option><option value="sections">Sections in ${escapeHtml(entry.title)}</option></select></label>
      <button id="sortBookEntries" type="button">Sort alphabetically</button>
      <ol id="bookOrderRows" class="book-order-list" aria-label="Order"></ol>
      <div class="book-edit-actions"><button type="submit" value="save">Apply order</button></div>`, () => {
      const blocks = orderSections(parts, sections);
      save(entries.map((item) => item === entry ? { ...item, blocks } : item), "Book order updated.");
    });
    const render = () => renderOrder($("#bookOrderRows"), scope === "entries" ? entries : sections, ({ title }) => title);
    form.elements.scope.addEventListener("change", () => {
      scope = form.elements.scope.value;
      $("#sortBookEntries").hidden = scope !== "entries";
      render();
    });
    $("#sortBookEntries").addEventListener("click", () => {
      entries.sort((first, second) => first.title.localeCompare(second.title, undefined, { sensitivity: "base", numeric: true }));
      render();
    });
    render();
  }

  function renderOrder(list, items, title, extra = () => {}) {
    const render = () => renderOrder(list, items, title, extra);
    function move(from, to) {
      if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
      items.splice(to, 0, items.splice(from, 1)[0]);
      render();
    }
    list.replaceChildren(...items.map((item, index) => {
      const row = document.createElement("li");
      row.draggable = true;
      row.innerHTML = `<span>${escapeHtml(title(item))}</span><button type="button" aria-label="Move ${escapeAttribute(title(item))} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="Move ${escapeAttribute(title(item))} down" ${index === items.length - 1 ? "disabled" : ""}>↓</button>`;
      const [, up, down] = row.children;
      for (const [button, offset] of [[up, -1], [down, 1]]) button.addEventListener("click", () => {
        move(index, index + offset);
        const controls = list.children[index + offset].querySelectorAll("button:not(:disabled)");
        controls[0]?.focus();
      });
      row.addEventListener("dragstart", (event) => event.dataTransfer.setData("application/x-book-order", String(index)));
      row.addEventListener("dragover", (event) => {
        if (event.dataTransfer.types.includes("application/x-book-order")) event.preventDefault();
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = event.dataTransfer.getData("application/x-book-order");
        if (from) move(Number(from), index);
      });
      extra(row, item);
      return row;
    }));
    if (!items.length) {
      const empty = document.createElement("li");
      empty.textContent = "No H3 sections in this view.";
      list.append(empty);
    }
  }

  function sectionName(title) { return title.trim().normalize("NFKC").toLowerCase(); }

  function editSectionRules() {
    if (!state.bookPackage) return;
    const names = new Map();
    for (const entry of state.entries) for (const { title } of splitSections(entry.blocks)) {
      if (!title) continue;
      const key = sectionName(title);
      if (!names.has(key)) names.set(key, { key, title, count: 0, hidden: hiddenSections.has(key) });
      names.get(key).count += 1;
    }
    const rows = [...new Set([...order, ...names.keys()])].filter((key) => names.has(key)).map((key) => names.get(key));
    open("Section rules", `<p>Order recurring H3 sections and choose which ones to hide in the player edition. Individual sections can override this in the preview editor.</p>
      <ol id="sectionRuleRows" class="book-order-list" aria-label="Section rules"></ol>
      <div class="book-edit-actions"><button type="submit" value="save">Apply rules</button></div>`, () => {
      order = rows.map(({ key }) => key);
      hiddenSections = new Set(rows.filter(({ hidden }) => hidden).map(({ key }) => key));
      const positions = new Map(order.map((key, index) => [key, index]));
      save(state.entries.map((entry) => {
        const parts = splitSections(entry.blocks);
        const sections = parts.filter((part) => part.title).sort((a, b) => positions.get(sectionName(a.title)) - positions.get(sectionName(b.title)));
        return { ...entry, blocks: orderSections(parts, sections) };
      }), "Section rules applied.");
    });
    renderOrder($("#sectionRuleRows"), rows, ({ title, count }) => `${title} (${count})`, (row, item) => {
      const label = document.createElement("label");
      label.className = "book-edit-check";
      label.innerHTML = `<input type="checkbox" ${item.hidden ? "checked" : ""}> Hide from players`;
      label.querySelector("input").addEventListener("change", ({ target }) => { item.hidden = target.checked; });
      row.append(label);
    });
  }

  function reviewSourceItems() {
    if (!state.bookPackage) return;
    const groups = new Map();
    function collect(kind, label, item) {
      const key = `${kind}:${sectionName(label)}`;
      if (!groups.has(key)) groups.set(key, { kind, label, items: [] });
      groups.get(key).items.push(item);
    }
    const locations = new Map();
    const headings = new Map();
    for (const entry of state.entries) {
      for (const block of entry.blocks) {
        if (block[sourceArtifact]) locations.set(block[sourceArtifact], { entry, block });
        if (block[sourceHeadingKey]) headings.set(block[sourceHeadingKey], entry);
        const image = block[markdownImage];
        if (image && !block[sourceArtifact]) collect("image", image.alt || image.url, { entry, block });
      }
    }
    for (const entry of state.entries) {
      for (const artifact of entry[sourceArtifact] || []) {
        const location = locations.get(artifact) || { entry: headings.get(artifact.anchor) || entry };
        collect(artifact.image ? "image" : "directive", artifact.label, { ...location, artifact });
      }
    }
    const list = [...groups.values()];
    open("Homebrewery items", `<p>Set a rule for artwork with the same label or for a recurring source directive.</p>
      ${list.length ? `<ul class="book-source-list">${list.map(({ kind, label, items }, index) => `<li><label><span>${escapeHtml(label)} <small>${kind === "image" ? "Image" : "Directive"} · ${items.length} · ${items.filter(({ block }) => block && !block[sourceHidden]).length} shown</small></span>
        <select name="source-${index}">${displayOptions([["", "Leave as is"], ["hide", "Hide"], ...(kind === "image" ? [["keep", "Keep as inline artwork"]] : [["callout", "Convert to callout"], ["divider", "Convert to separator"]])], "")}</select></label></li>`).join("")}</ul>` : "<p>No Homebrewery items were found.</p>"}
      ${list.length ? '<div class="book-edit-actions"><button type="submit" value="save">Apply source rules</button></div>' : ""}`, () => {
      const choices = list.flatMap(({ items }, index) => {
        const choice = form.elements[`source-${index}`].value;
        return choice ? items.map((item) => ({ ...item, choice })) : [];
      });
      const entries = state.entries.map((entry) => {
        const blocks = [...entry.blocks];
        for (const { artifact, block, choice } of choices.filter((choice) => choice.entry === entry)) {
          if (choice === "hide" && !block) continue;
          if (choice === "hide" || choice === "keep" && block) {
            const updated = { ...block, [sourceHidden]: choice === "hide" };
            if (choice === "keep") {
              updated.placement = "inline";
              delete updated.className;
              delete updated.width;
            }
            blocks[blocks.indexOf(block)] = updated;
            continue;
          }
          const source = artifact.image;
          const converted = source ? { type: "image", role: imageRole(source.alt), placement: "inline", [markdownImage]: source,
            assetId: ensureAsset(source.url, source.alt, imageRole(source.alt)) }
            : choice === "divider" ? { type: "divider", style: "rule" }
              : { type: "paragraph", style: "book-callout", text: artifact.text || artifact.label };
          converted[sourceArtifact] = artifact;
          const at = block ? blocks.indexOf(block) : sourceInsertIndex(blocks, artifact);
          blocks.splice(at, block ? 1 : 0, converted);
        }
        return { ...entry, blocks };
      });
      if (choices.length) save(entries, "Homebrewery rules applied.");
      else dialog.close();
    });
  }

  function sourceInsertIndex(blocks, artifact) {
    let start = artifact.anchor ? blocks.findIndex((block) => block[sourceHeadingKey] === artifact.anchor) : -1;
    if (start < 0 && artifact.heading) start = blocks.findIndex((block) => block.type === "heading" && block.text === artifact.heading);
    const next = blocks.findIndex((block, index) => index > start && block.type === "heading");
    return next === -1 ? blocks.length : next;
  }

  function exportPackage() {
    const book = state.bookPackage;
    if (!book) return null;
    const player = $("#exportEdition").value === "player";
    if (!player && !state.visualEdits) return book;
    const referenced = new Set();
    const entries = book.entries.map((entry) => {
      const parts = player ? splitSections(entry.blocks).filter(({ title, blocks: [heading] }) =>
        !title || heading[sectionVisibility] === "include" ||
        (heading[sectionVisibility] !== "exclude" && !hiddenSections.has(sectionName(title)))) : [{ blocks: entry.blocks }];
      const blocks = parts.flatMap(({ blocks }) => blocks.filter((block) => !block[sourceHidden]));
      for (const block of blocks) if (block.type === "image") referenced.add(block.assetId);
      return { ...entry, blocks };
    });
    return { ...book, entries, assets: book.assets.filter(({ id }) => referenced.has(id)) };
  }
})();
