// The base application version is independent of the book JSON schema.
// The Pages build stamps its actual build number into both HTML files.
const CONTENT_LAB_VERSION = "0.1.0";
const contentLabVersionBadge = document.getElementById("appVersion");
if (contentLabVersionBadge && !contentLabVersionBadge.hasAttribute("data-build-version")) {
  contentLabVersionBadge.textContent = `v${CONTENT_LAB_VERSION}-local`;
  contentLabVersionBadge.title = `Content Lab ${CONTENT_LAB_VERSION} (local development)`;
}
