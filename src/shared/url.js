// URL decomposition for the domain/path memory hierarchy.

// "https://a.b/x/y?q#h" -> { domain: "a.b", path: "/x/y", pathSegments: ["x","y"], pathDepth: 2 }
export function parseUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    return {
      domain: u.hostname,
      path: u.pathname === "" ? "/" : u.pathname,
      pathSegments: segments,
      pathDepth: segments.length
    };
  } catch {
    return { domain: "", path: "/", pathSegments: [], pathDepth: 0 };
  }
}

// Canonical form for dedupe: no hash, no trailing slash noise.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}
