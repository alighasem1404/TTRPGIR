(() => {
  const BOOK_PATH = "book.json";
  const MAX_FILES = 4096;
  const MAX_BOOK_BYTES = 32 * 1024 ** 2;
  const MAX_ARCHIVE_BYTES = 512 * 1024 ** 2;
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const isImagePath = (path) => /^images\/[^/\\:\x00-\x1f]+\.png$/i.test(path);

  window.bookArchive = { create, open, reservedImagePaths };

  function reservedImagePaths(assets) {
    const root = new URL("https://book.invalid/package/");
    const paths = new Set();
    for (const { src } of assets) {
      try {
        const url = new URL(src, root);
        if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) continue;
        const path = decodeURIComponent(url.pathname.slice(root.pathname.length));
        if (isImagePath(path)) paths.add(path.toLowerCase());
      } catch {
        // A malformed source is still available to the normal image-link checker.
      }
    }
    return paths;
  }

  async function create(book, recoveryForBlock) {
    const { output, files } = prepareBook(book, recoveryForBlock);
    const json = JSON.stringify(output, null, 2);
    const bookSize = new Blob([json]).size;
    if (bookSize > MAX_BOOK_BYTES) throw new Error("The book JSON exceeds 32 MiB.");
    const imageSize = [...files.values()].reduce((size, file) => size + file.size, 0);
    if (bookSize + imageSize > MAX_ARCHIVE_BYTES || files.size + 2 > MAX_FILES) {
      throw new Error("The book exceeds the Reader’s ZIP size or file count limit.");
    }

    const zip = new JSZip();
    zip.file(BOOK_PATH, json, { compression: "DEFLATE" });
    for (const [path, file] of files) {
      zip.file(path, new Uint8Array(await file.arrayBuffer()), { compression: "STORE" });
    }
    const blob = await zip.generateAsync({ type: "blob" });
    if (blob.size > MAX_ARCHIVE_BYTES) throw new Error("The finished ZIP exceeds 512 MiB.");
    return { blob, imageCount: files.size };
  }

  function prepareBook(book, recoveryForBlock) {
    const originals = new Map(book.assets.map((asset) => [asset.id, asset]));
    const reservedPaths = reservedImagePaths(book.assets);
    const usedIds = new Set(originals.keys());
    const replacedIds = new Set();
    const referencedIds = new Set();
    const recovered = [];
    const files = new Map();
    const entries = book.entries.map((entry) => ({
      ...entry,
      blocks: entry.blocks.map((block) => {
        if (block.type !== "image") return block;
        const recovery = recoveryForBlock(block);
        if (!recovery) {
          referencedIds.add(block.assetId);
          return block;
        }
        const original = originals.get(block.assetId);
        if (!original) throw new Error("A recovered image has no original asset record.");
        const name = recovery.fileName;
        if (!isImagePath(`images/${name}`)) throw new Error("A recovered image has an invalid PNG filename.");
        const basePath = `images/${name.slice(0, -4)}`;
        let src = `images/${name}`;
        for (let suffix = 2; reservedPaths.has(src.toLowerCase()); suffix += 1) src = `${basePath}-${suffix}.png`;
        reservedPaths.add(src.toLowerCase());

        const baseId = `${original.id}-recovered`;
        let id = baseId;
        for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
        usedIds.add(id);

        replacedIds.add(original.id);
        recovered.push({ ...original, id, src, alt: recovery.caption });
        files.set(src, recovery.blob);
        return { ...block, assetId: id };
      })
    }));
    const assets = book.assets.filter(({ id }) => !replacedIds.has(id) || referencedIds.has(id));
    return { output: { ...book, entries, assets: [...assets, ...recovered] }, files };
  }

  async function open(file, validateBook, signal) {
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error("The ZIP exceeds the 512 MiB size limit.");
    signal.throwIfAborted();
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    signal.throwIfAborted();
    if (Object.keys(zip.files).length > MAX_FILES) throw new Error("The ZIP contains too many files.");
    const bookFile = zip.file(BOOK_PATH);
    if (bookFile?.unsafeOriginalName !== BOOK_PATH) throw new Error("The ZIP must contain book.json at its top level.");

    const json = await readEntry(bookFile, MAX_BOOK_BYTES, signal);
    const bookPackage = JSON.parse(await json.text());
    validateBook(bookPackage);

    const images = new Map();
    let remaining = MAX_ARCHIVE_BYTES - json.size;
    const paths = new Set(bookPackage.assets.map(({ src }) => src).filter(isImagePath));
    for (const path of paths) {
      const member = zip.file(path);
      if (!member) continue;
      if (member.unsafeOriginalName !== path) throw new Error(`Invalid path for ${path}.`);
      const image = await readEntry(member, remaining, signal, "image/png");
      const prefix = new Uint8Array(await image.slice(0, PNG_SIGNATURE.length).arrayBuffer());
      if (!PNG_SIGNATURE.every((byte, index) => prefix[index] === byte)) throw new Error(`Invalid PNG file at ${path}.`);
      remaining -= image.size;
      images.set(path, image);
    }
    return { bookPackage, images };
  }

  function readEntry(entry, maxBytes, signal, type) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let finished = false;
      const stream = entry.internalStream("uint8array");
      const cancel = () => fail(signal.reason);
      function fail(error) {
        if (finished) return;
        finished = true;
        stream.pause();
        chunks.length = 0;
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
      signal.addEventListener("abort", cancel, { once: true });
      stream.on("data", (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > maxBytes) fail(new Error(`The expanded ZIP exceeds the size limit while reading ${entry.name}.`));
        else chunks.push(chunk);
      }).on("error", fail).on("end", () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", cancel);
        resolve(new Blob(chunks, { type }));
      }).resume();
    });
  }
})();
