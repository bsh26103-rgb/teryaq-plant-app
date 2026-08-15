const THEME_KEY = "plantai_theme";

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  return next;
}

function wireThemeToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const paint = () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M4.5 15.5l1.4-1.4M14.1 5.9l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M17 11.5A7 7 0 1 1 8.5 3a5.5 5.5 0 0 0 8.5 8.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  };
  paint();
  btn.addEventListener("click", () => { toggleTheme(); paint(); });
}

const HISTORY_KEY = "scan25_history";
const LAST_RESULT_KEY = "scan25_last_result";
const MAX_HISTORY = 20;

function saveToHistory(entry) {
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { hist = []; }
  hist.unshift(entry);
  if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e) {
    hist = hist.slice(0, 5);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e2) {}
  }
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

function verdictOf(data) {
  const info = data.info || {};
  if (data.status === "ok" && info.poisonous) return { cls: "danger", label: "خطر — سام" };
  if (data.status === "ok") return { cls: "safe", label: "آمن — طبي" };
  if (data.status === "low_confidence") return { cls: "caution", label: "غير مؤكد" };
  return { cls: "danger", label: "غير معروف" };
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  });
}
