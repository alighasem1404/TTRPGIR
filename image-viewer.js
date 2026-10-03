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
