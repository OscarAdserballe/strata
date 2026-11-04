const courseOf = (t) => String(t || "").split(/:| — | - /)[0].trim();

function ago(ts) {
  if (!ts) return "";
  const m = Math.max(0, (Date.now() - ts) / 60000);
  if (m < 2) return "just now";
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)} days ago`;
  if (d < 63) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30.4)} months ago`;
}

export { courseOf, ago };
