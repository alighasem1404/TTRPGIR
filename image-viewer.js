(() => {
  const dialog = document.createElement("dialog");
  dialog.className = "image-lightbox";
  dialog.setAttribute("aria-label", "Image preview");
  dialog.innerHTML = `
    <button class="image-lightbox-close" type="button" aria-label="Close image preview">×</button>
    <img class="image-lightbox-image" alt="">
    <p class="image-lightbox-caption"></p>`;
  document.body.append(dialog);

  const closeButton = dialog.querySelector(".image-lightbox-close");
  const preview = dialog.querySelector(".image-lightbox-image");
  const caption = dialog.querySelector(".image-lightbox-caption");
  let invokingImage = null;
  let reloadRequest = 0;
  const originalSources = new WeakMap();

  document.getElementById("reloadImages").addEventListener("click", async () => {
    const request = ++reloadRequest;
    const entry = document.querySelector("#pageViewport .book-page");
    const images = [...(entry?.querySelectorAll("img[src]") || [])];
    const pending = images.filter((image) => !image.complete || !image.naturalWidth);
    if (!images.length) return showNotice("No images in this entry.");
    if (!pending.length) return showNotice("All images in this entry are loaded.");

    showNotice(`Retrying ${pending.length} image${pending.length === 1 ? "" : "s"}…`);
    const loaded = await Promise.all(pending.map((image) => retryImage(image, request)));
    if (request !== reloadRequest || !entry.isConnected) return;
    const success = loaded.filter(Boolean).length;
    const remaining = pending.length - success;
    showNotice(`${success} of ${pending.length} images loaded.${remaining ? ` ${remaining} still unavailable.` : ""}`);
  });

  async function retryImage(image, request) {
    const source = originalSources.get(image) || image.getAttribute("src");
    if (!source) return false;
    originalSources.set(image, source);
    image.loading = "eager";
    let url;
    try { url = new URL(source, document.baseURI); } catch { return false; }

    const isWebImage = ["http:", "https:"].includes(url.protocol);
    const original = url.href;
    if (isWebImage) url.search += `${url.search ? "&" : "?"}_bookImageRetry=${Date.now()}-${request}`;
    image.src = url.href;
    try {
      await image.decode();
      return true;
    } catch {
      // Some image hosts require the exact original URL, including its query string.
      if (!isWebImage || request !== reloadRequest || !image.isConnected) return false;
      image.src = original;
      try {
        await image.decode();
        return true;
      } catch { return false; }
    }
  }

  function openImage(image) {
    const source = image.currentSrc || image.src;
    if (!source) return;
    invokingImage = image;
    preview.src = source;
    preview.alt = image.alt || "Enlarged book image";
    caption.textContent = image.closest("figure")?.querySelector("figcaption")?.textContent.trim() || image.alt || "";
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("image-lightbox-open");
    closeButton.focus({ preventScroll: true });
  }

  function activateImage(event) {
    const image = event.target instanceof Element ? event.target.closest("img[data-image-viewer]") : null;
    if (!image) return;
    event.preventDefault();
    openImage(image);
  }

  document.addEventListener("click", activateImage);
  document.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element) || !event.target.matches("img[data-image-viewer]")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openImage(event.target);
  });

  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("image-lightbox-open");
    preview.removeAttribute("src");
    if (invokingImage?.isConnected) invokingImage.focus({ preventScroll: true });
    invokingImage = null;
  });
})();
