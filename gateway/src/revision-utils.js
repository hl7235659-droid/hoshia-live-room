export function pickRuntimeRevision(candidates = [], sanitize = defaultRevisionSanitizer) {
  for (const candidate of candidates) {
    const safe = sanitize(candidate);
    if (!safe) continue;
    if (String(safe).trim().toLowerCase() === "unknown") continue;
    return safe;
  }
  return "unknown";
}

function defaultRevisionSanitizer(value) {
  return String(value || "").trim();
}
