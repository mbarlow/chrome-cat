// Runtime <all_urls> grant (chrome-packetlens pattern). activeTab covers the
// current tab after a toolbar-click gesture; crawl-window tabs have no gesture,
// so captureVisibleTab there needs the optional host permission.

const ORIGINS = { origins: ["<all_urls>"] };

export function hasAllUrls() {
  return chrome.permissions.contains(ORIGINS);
}

// Must be called from a user-gesture handler (button click).
export function requestAllUrls() {
  return chrome.permissions.request(ORIGINS);
}
