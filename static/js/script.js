/* ==========================================================================
   Teryaq — script.js
   Talks to the real Flask backend: POST /predict, GET /health, GET /plants,
   POST /chat. No demo/fake data.
   ========================================================================== */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Small helper so a missing element (e.g. index.html and script.js
  // temporarily out of sync while updating the app) never crashes the
  // whole script — it just skips that one feature instead of blocking
  // everything below it (like the upload button).
  // ---------------------------------------------------------------------
  function on(el, event, handler) {
    if (el) el.addEventListener(event, handler);
  }

  // Render Lucide SVG icons (sidebar nav, etc.) — must run after they're
  // inserted in the DOM. Safe no-op if the CDN script failed to load.
  if (window.lucide) lucide.createIcons();

  // ---------------------------------------------------------------------
  // Global drag-and-drop safety net.
  // Without this, a drop that lands a few pixels outside the intended
  // upload box (very easy to do) falls through to the browser's default
  // behaviour: it navigates the tab/opens a new tab showing the raw image
  // file instead of reaching our drop handlers below. This blocks that
  // default everywhere on the page; the specific dropzone/heroUpload
  // handlers further down still do the actual upload work.
  // ---------------------------------------------------------------------
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // Settings dropdown (language / theme / sound), triggered by the ☰ icon.
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = settingsPanel.classList.toggle("open");
      settingsBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
        settingsPanel.classList.remove("open");
        settingsBtn.setAttribute("aria-expanded", "false");
      }
    });
    settingsPanel.addEventListener("click", (e) => e.stopPropagation());
  }

  // Insurance: make sure no overlay starts in a "stuck open" state on a
  // fresh page load (would silently block every click on the whole app).
  document.querySelectorAll(".enc-overlay.show, .scan-overlay.show").forEach((ov) => {
    ov.classList.remove("show");
    ov.setAttribute("aria-hidden", "true");
  });

  // ---------------------------------------------------------------------
  // Page navigation
  // ---------------------------------------------------------------------
  document.querySelectorAll("[data-page]").forEach((navEl) => {
    navEl.addEventListener("click", () => goPage(navEl.getAttribute("data-page")));
  });

  // Deep-link support: /#chatbot, /#history etc. (used by links from the other pages)
  if (location.hash) {
    const target = location.hash.replace("#", "");
    if (document.getElementById("page-" + target)) {
      goPage(target);
    }
  }

  function goPage(name) {
    // Safety net: if a modal (plant detail, mood recipe, scan overlay) got
    // left open/stuck, it sits on top of everything with pointer-events:
    // auto and silently swallows every click on the page underneath —
    // looks exactly like "nothing is clickable". Force them all closed on
    // every navigation so that can never persist across pages.
    document.querySelectorAll(".enc-overlay.show, .scan-overlay.show").forEach((ov) => {
      ov.classList.remove("show");
      ov.setAttribute("aria-hidden", "true");
    });

    document.querySelectorAll(".page").forEach((p) => p.classList.remove("on"));
    document.querySelectorAll(".nav[data-page], .bnav[data-page]").forEach((n) => n.classList.remove("on"));
    const page = document.getElementById("page-" + name);
    document.querySelectorAll(`.nav[data-page="${name}"], .bnav[data-page="${name}"]`).forEach((n) => n.classList.add("on"));
    if (page) page.classList.add("on");
    if (name === "history") renderHistory();
    if (name === "chatbot" && !chatStarted) startChat();
    if ((name === "encyclopedia" || name === "compare") && !encLoaded) loadEncyclopedia();
    if (name === "compare" && encLoaded) renderCompare();
    if (name === "herbarium") { if (!encLoaded) loadEncyclopedia(); else renderHerbarium(); }
    if (name === "mood") { if (!encLoaded) loadEncyclopedia(); else renderMood(); }
    if (name === "dashboard") loadDashboard();
    if (name === "home") { loadHomeStats(); renderHomeRecent(); }
    if (name === "learning") { renderLearnFilters(); renderLearningCenter(); if (!encLoaded) loadEncyclopedia(); else { populateGrowPlanPlantSelect(); renderGrowPlan(); } }
    if (name === "calendar") { if (!encLoaded) loadEncyclopedia(); else renderCalendar(); }
  }

  // Extra safety net: Escape key force-closes any stuck overlay too.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".enc-overlay.show, .scan-overlay.show").forEach((ov) => {
      ov.classList.remove("show");
      ov.setAttribute("aria-hidden", "true");
    });
  });

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  const THEME_KEY = "plantai_theme";
  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    document.getElementById("themeDarkBtn").classList.toggle("on", theme === "dark");
    document.getElementById("themeLightBtn").classList.toggle("on", theme === "light");
  }
  window.setTheme = applyTheme;
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");

  // Language: i18n.js defines setLang()/applyLang(); wire post-switch hooks here.
  window.onLangChange = () => { renderHistory(); renderSoundBtn(); renderHomeRecent(); renderLearnFilters(); renderLearningCenter(); if (lastRenderedResult) renderResult(lastRenderedResult); if (encLoaded) { populateCompareSelects(); renderCompare(); renderHerbarium(); renderMood(); renderPlantOfDay(); renderCalendar(); populateGrowPlanPlantSelect(); renderGrowPlan(); } if (dashData) renderDashboard(); };
  applyLang(currentLang);

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  const toast = document.getElementById("toast");
  let toastTimer = null;
  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  // ---------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  fetch("/health")
    .then((r) => r.json())
    .then((h) => {
      statusDot.classList.add("ok");
      statusText.textContent = `${t("online")} · ${h.num_classes} · ${h.device.toUpperCase()}`;
      statusText.removeAttribute("data-i18n");
    })
    .catch(() => {
      statusDot.classList.add("off");
      statusText.textContent = t("offline");
      statusText.removeAttribute("data-i18n");
    });

  // Populate the class chips on the Analysis page, and keep the list itself
  // for the Herbarium page (to know the full roster + what's still locked).
  let allClassNames = [];
  fetch("/plants")
    .then((r) => r.json())
    .then((d) => {
      allClassNames = d.classes || [];
      const wrap = document.getElementById("classChips");
      allClassNames.forEach((c) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = c;
        wrap.appendChild(chip);
      });
      if (document.querySelector('.nav[data-page="herbarium"]')?.classList.contains("on")) renderHerbarium();
    })
    .catch(() => {});

  // ---------------------------------------------------------------------
  // Sound effects — procedural Web Audio (no audio files, stays tiny).
  // Just the randomized digital "blips" (binary-data-on-a-screen feel)
  // while the AI is "working" — no ambient pad underneath, single sound
  // only — then a soft chime when the result is ready. Respects a
  // persisted on/off toggle.
  // ---------------------------------------------------------------------
  const SOUND_KEY = "plantai_sound";
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== "off";
  let audioCtx = null;
  let blipTimer = null;
  let blipsActive = false;

  function getAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  // A single short "bit" of digital data — random pitch, tiny duration.
  function playBlip() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = Math.random() < 0.5 ? "square" : "sine";
    osc.frequency.value = 650 + Math.random() * 1700; // scattered across a "digital" range
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.02, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03 + Math.random() * 0.02);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  // Recursive random-delay loop (not setInterval) so the blips land
  // irregularly, like a screen actually reading fast-changing data.
  function scheduleBlips() {
    if (!blipsActive || !soundEnabled) return;
    playBlip();
    blipTimer = setTimeout(scheduleBlips, 50 + Math.random() * 90);
  }

  function startHum() {
    if (!soundEnabled) return;
    blipsActive = true;
    scheduleBlips();
  }

  function stopHum() {
    blipsActive = false;
    clearTimeout(blipTimer);
  }

  // A very soft, high, quick tick — like a HUD registering a step, not a beep.
  function playTick() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1100, now);
    osc.frequency.exponentialRampToValueAtTime(650, now + 0.06);
    gain.gain.setValueAtTime(0.018, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  // Soft three-note chime (fifth + octave) instead of a flat two-tone ding —
  // reads as a pleasant confirmation, closer to a film UI than a game.
  function playDing() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [660, 990, 1320].forEach((freq, i) => {
      const start = now + i * 0.045;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.045 - i * 0.01, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.48);
    });
  }

  const soundToggleBtn = document.getElementById("soundToggleBtn");
  function renderSoundBtn() {
    if (!soundToggleBtn) return;
    soundToggleBtn.textContent = soundEnabled ? "🔊" : "🔇";
    soundToggleBtn.classList.toggle("on", soundEnabled);
    soundToggleBtn.setAttribute("aria-label", soundEnabled ? t("soundOn") : t("soundOff"));
  }
  renderSoundBtn();
  on(soundToggleBtn, "click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
    renderSoundBtn();
    if (!soundEnabled) stopHum(true);
  });

  // ---------------------------------------------------------------------
  // Scan overlay — the "AI Analysis" modal with the moving scan line,
  // reusing the .stage/.sbar building blocks already defined in the CSS.
  // ---------------------------------------------------------------------
  const scanOverlay = document.getElementById("scanOverlay");
  const scanImg = document.getElementById("scanImg");
  const scanCheck = document.getElementById("scanCheck");
  const scanStages = document.getElementById("scanStages");

  const STAGE_ICONS = ["📤", "🧬", "🧠", "🧩", "⚖️", "✨"];
  const STAGE_KEYS = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6"];
  const STAGE_STEP_MS = [260, 320, 420, 420, 320]; // last stage (index 5) just holds until the real response

  let stageTimer = null;

  function buildStages() {
    scanStages.innerHTML = "";
    STAGE_KEYS.forEach((key, i) => {
      const row = document.createElement("div");
      row.className = "stage";
      row.innerHTML = `<span class="si">${STAGE_ICONS[i]}</span><div class="sbody"><span data-i18n="${key}">${t(key)}</span><div class="sbar"><i></i></div></div>`;
      scanStages.appendChild(row);
    });
  }

  function runStages() {
    clearTimeout(stageTimer);
    const rows = Array.from(scanStages.children);
    let i = 0;
    function step() {
      if (i > 0) {
        rows[i - 1].classList.remove("active");
        rows[i - 1].classList.add("done");
        rows[i - 1].querySelector(".sbar i").style.width = "100%";
      }
      if (i >= rows.length) return;
      rows[i].classList.add("active");
      playTick();
      const bar = rows[i].querySelector(".sbar i");
      requestAnimationFrame(() => { bar.style.width = "75%"; });
      if (i < STAGE_STEP_MS.length) {
        stageTimer = setTimeout(() => { i++; step(); }, STAGE_STEP_MS[i]);
      }
    }
    step();
  }

  function finishStages() {
    clearTimeout(stageTimer);
    Array.from(scanStages.children).forEach((r) => {
      r.classList.remove("active"); r.classList.add("done");
      r.querySelector(".sbar i").style.width = "100%";
    });
  }

  function openScanOverlay(imgSrc) {
    scanImg.src = imgSrc;
    scanCheck.classList.remove("show");
    buildStages();
    scanOverlay.classList.add("show");
    scanOverlay.setAttribute("aria-hidden", "false");
    startHum();
    runStages();
  }

  function abortScanOverlay() {
    clearTimeout(stageTimer);
    stopHum(true);
    scanOverlay.classList.remove("show");
    scanOverlay.setAttribute("aria-hidden", "true");
  }

  function closeScanOverlay(onDone) {
    finishStages();
    stopHum(false);
    setTimeout(() => playDing(), 90);
    scanCheck.classList.add("show");
    setTimeout(() => {
      scanOverlay.classList.remove("show");
      scanOverlay.setAttribute("aria-hidden", "true");
      if (onDone) onDone();
    }, 430);
  }

  // ---------------------------------------------------------------------
  // Encyclopedia — browsable grid of all species, backed by /plants-all.
  // ---------------------------------------------------------------------
  let encLoaded = false;
  let encPlants = [];
  let compoundGlossary = {};
  let encFilter = "all";
  let encQuery = "";

  const encGrid = document.getElementById("encGrid");
  const encEmpty = document.getElementById("encEmpty");
  const encFiltersEl = document.getElementById("encFilters");
  const encSearch = document.getElementById("encSearch");
  const encOverlay = document.getElementById("encOverlay");

  const ENC_FILTERS = ["all", "favorites", "medicinal", "safe", "low_toxic", "dangerous", "highly_toxic"];
  const ENC_TOX_ICON = { safe: "🌿", low_toxic: "🍃", dangerous: "⚠️", highly_toxic: "☠️", unknown: "🌱" };
  const ENC_TOX_KEY = { safe: "toxSafe", low_toxic: "toxLowToxic", dangerous: "toxDangerous", highly_toxic: "toxHighlyToxic", unknown: "toxLevelUnknown" };

  // ---------------------------------------------------------------------
  // Favorites — a simple starred list, separate from the auto-populated
  // Herbarium. Stored locally like everything else in this app.
  // ---------------------------------------------------------------------
  const FAV_KEY = "plantai_favorites";
  function getFavorites() {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []); } catch (e) { return new Set(); }
  }
  function saveFavorites(set) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch (e) {}
  }
  function isFavorite(key) { return getFavorites().has(key); }
  function toggleFavorite(key) {
    const favs = getFavorites();
    if (favs.has(key)) favs.delete(key); else favs.add(key);
    saveFavorites(favs);
    return favs.has(key);
  }
  function popFav(el) {
    if (!el) return;
    el.classList.remove("fav-pop");
    void el.offsetWidth;
    el.classList.add("fav-pop");
  }

  function encFilterLabel(f) {
    if (f === "all") return t("encFilterAll");
    if (f === "favorites") return "⭐ " + t("encFavorites");
    if (f === "medicinal") return t("badgeMedicinal");
    return t(ENC_TOX_KEY[f] || "toxLevelUnknown");
  }

  function renderEncFilters() {
    if (!encFiltersEl) return;
    encFiltersEl.innerHTML = "";
    ENC_FILTERS.forEach((f) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "enc-chip" + (encFilter === f ? " on" : "");
      chip.textContent = encFilterLabel(f);
      chip.addEventListener("click", () => { encFilter = f; renderEncFilters(); renderEncGrid(); });
      encFiltersEl.appendChild(chip);
    });
  }

  function skeletonCardsHtml(count) {
    let html = "";
    for (let i = 0; i < count; i++) {
      html += `<div class="skel-card">
        <div class="skeleton skel-icon"></div>
        <div class="skeleton skel-line"></div>
        <div class="skeleton skel-line short"></div>
      </div>`;
    }
    return html;
  }

  function loadEncyclopedia() {
    if (encGrid) encGrid.innerHTML = skeletonCardsHtml(10);
    fetch("/plants-all")
      .then((r) => r.json())
      .then((d) => {
        encPlants = d.plants || [];
        compoundGlossary = d.compound_glossary || {};
        encLoaded = true;
        renderEncFilters();
        renderEncGrid();
        populateCompareSelects();
        renderCompare();
        renderHerbarium();
        renderMood();
        renderPlantOfDay();
        renderCalendar();
        populateGrowPlanPlantSelect();
        renderGrowPlan();
      })
      .catch(() => { if (encGrid) encGrid.innerHTML = `<p class="info-text">${t("errNoServer")}</p>`; });
  }

  function renderEncGrid() {
    if (!encGrid || !encEmpty) return;
    const q = encQuery.trim().toLowerCase();
    const favs = getFavorites();
    const filtered = encPlants.filter((p) => {
      if (encFilter === "favorites" && !favs.has(p.key)) return false;
      if (encFilter === "medicinal" && !p.medicinal) return false;
      if (encFilter !== "all" && encFilter !== "favorites" && encFilter !== "medicinal" && p.toxicity_level !== encFilter) return false;
      if (!q) return true;
      const haystack = [p.english_name, p.arabic_name, p.scientific_name, p.family, p.key]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });

    encGrid.innerHTML = "";
    if (encFilter === "favorites" && !filtered.length) {
      encEmpty.style.display = "block";
      encEmpty.querySelector("p").textContent = t("encNoFavorites");
    } else {
      encEmpty.style.display = filtered.length ? "none" : "block";
      encEmpty.querySelector("p").textContent = t("encNoResults");
    }

    filtered.forEach((p) => {
      const name = (currentLang === "ar" && p.arabic_name) ? p.arabic_name : ((currentLang === "ar" && p.scientific_name) ? p.scientific_name : (p.english_name || p.key));
      const tox = p.toxicity_level || "unknown";
      const fav = favs.has(p.key);
      const card = document.createElement("div");
      card.className = "enc-card tox-" + tox;
      card.innerHTML = `
        <button type="button" class="enc-fav-btn${fav ? " on" : ""}" aria-label="${t(fav ? "encFavRemove" : "encFavAdd")}">★</button>
        <div class="enc-icon">${ENC_TOX_ICON[tox] || "🌱"}</div>
        <div class="enc-name">${name}</div>
        <div class="enc-sci">${p.scientific_name || ""}</div>
        <div class="enc-tox-label">${t(ENC_TOX_KEY[tox] || "toxLevelUnknown")}</div>
      `;
      card.querySelector(".enc-fav-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const nowFav = toggleFavorite(p.key);
        e.currentTarget.classList.toggle("on", nowFav);
        e.currentTarget.setAttribute("aria-label", t(nowFav ? "encFavRemove" : "encFavAdd"));
        popFav(e.currentTarget);
        if (encFilter === "favorites") renderEncGrid();
      });
      card.addEventListener("click", () => openEncDetail(p));
      encGrid.appendChild(card);
    });
  }

  on(encSearch, "input", () => { encQuery = encSearch.value; renderEncGrid(); });

  let encCurrentPlant = null;

  function fillEncRow(rowId, valEl, text) {
    const row = document.getElementById(rowId);
    if (text) { document.getElementById(valEl).textContent = text; row.style.display = "block"; }
    else { row.style.display = "none"; }
  }

  function openEncDetail(p) {
    encCurrentPlant = p;
    const isAr = currentLang === "ar";
    document.getElementById("encModalIcon").textContent = ENC_TOX_ICON[p.toxicity_level || "unknown"] || "🌱";
    document.getElementById("encModalName").textContent = (isAr && p.arabic_name) ? p.arabic_name : ((isAr && p.scientific_name) ? p.scientific_name : (p.english_name || p.key));
    document.getElementById("encModalSci").textContent = p.scientific_name || "";

    const favBtn = document.getElementById("encModalFavBtn");
    if (favBtn) {
      const fav = isFavorite(p.key);
      favBtn.classList.toggle("on", fav);
      favBtn.setAttribute("aria-label", t(fav ? "encFavRemove" : "encFavAdd"));
    }

    const badges = document.getElementById("encModalBadges");
    badges.innerHTML = "";
    const addBadge = (cls, label) => {
      const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = label;
      badges.appendChild(b);
    };
    addBadge("tox-" + (p.toxicity_level || "unknown"), t(ENC_TOX_KEY[p.toxicity_level] || "toxLevelUnknown"));
    if (p.medicinal) addBadge("medicinal", t("badgeMedicinal"));

    document.getElementById("encAttrFamily").textContent = (isAr && p.family_ar) ? p.family_ar : (p.family || "—");
    document.getElementById("encAttrHabitat").textContent = (isAr && p.habitat_ar) ? p.habitat_ar : (p.habitat || "—");

    const descText = (isAr && p.description_ar) ? p.description_ar : p.description;
    const descEl = document.getElementById("encDesc");
    if (descText) { descEl.textContent = descText; descEl.style.display = "block"; } else descEl.style.display = "none";

    const usesArr = (isAr && p.uses_ar && p.uses_ar.length) ? p.uses_ar : p.uses;
    document.getElementById("encUses").textContent = (usesArr || []).join(" · ");
    document.getElementById("encRowUses").style.display = (usesArr && usesArr.length) ? "block" : "none";

    const tagsEl = document.getElementById("encTags");
    tagsEl.innerHTML = "";
    (p.active_compounds || []).forEach((c) => {
      const s = document.createElement("span"); s.className = "tag"; s.textContent = c;
      const info = compoundGlossary[c];
      if (info) s.title = (isAr ? info.ar : info.en) || "";
      tagsEl.appendChild(s);
    });

    const effectsEl = document.getElementById("encCompoundEffects");
    const effectRows = (p.active_compounds || [])
      .map((c) => {
        const info = compoundGlossary[c];
        return info ? `<div class="compound-effect-row"><b>${c}:</b> ${(isAr ? info.ar : info.en) || ""}</div>` : "";
      })
      .filter(Boolean);
    if (effectRows.length) {
      effectsEl.innerHTML = `<div class="compound-effects-label">${t("compoundEffectsLabel")}</div>` + effectRows.join("");
      effectsEl.style.display = "block";
    } else {
      effectsEl.style.display = "none";
    }

    fillEncRow("encRowWarn", "encWarn", (isAr && p.warnings_ar) ? p.warnings_ar : p.warnings);
    fillEncRow("encRowGrowing", "encGrowing", (isAr && p.growing_method_ar) ? p.growing_method_ar : p.growing_method);
    fillEncRow("encRowCare", "encCare", (isAr && p.care_ar) ? p.care_ar : p.care);
    const pestsArr = (isAr && p.common_pests_ar && p.common_pests_ar.length) ? p.common_pests_ar : p.common_pests;
    fillEncRow("encRowPests", "encPests", pestsArr && pestsArr.length ? pestsArr.join(" · ") : null);
    fillEncRow("encRowDistribution", "encDistribution", (isAr && p.geographic_distribution_ar) ? p.geographic_distribution_ar : p.geographic_distribution);
    fillEncRow("encRowDosage", "encDosage", (isAr && p.safe_dosage_ar) ? p.safe_dosage_ar : p.safe_dosage);

    const interEl = document.getElementById("encInteractions");
    if (interEl) {
      if (p.drug_interactions && p.drug_interactions.length) {
        let html = `<div class="compound-effects-label">${t("interactionsTitle")}</div>`;
        p.drug_interactions.forEach((row) => {
          html += `<div class="compound-effect-row"><b>${isAr ? row.ar : row.en}:</b> ${isAr ? row.note_ar : row.note_en}</div>`;
        });
        html += `<p class="info-text warn" style="margin-top:6px">${t("interactionsDisclaimer")}</p>`;
        interEl.innerHTML = html;
        interEl.style.display = "block";
      } else {
        interEl.innerHTML = "";
        interEl.style.display = "none";
      }
    }

    encOverlay.classList.add("show");
    encOverlay.setAttribute("aria-hidden", "false");
  }

  function closeEncDetail() {
    encOverlay.classList.remove("show");
    encOverlay.setAttribute("aria-hidden", "true");
  }
  on(document.getElementById("encCloseBtn"), "click", closeEncDetail);
  on(document.getElementById("encModalFavBtn"), "click", () => {
    if (!encCurrentPlant) return;
    const nowFav = toggleFavorite(encCurrentPlant.key);
    const favBtn = document.getElementById("encModalFavBtn");
    favBtn.classList.toggle("on", nowFav);
    favBtn.setAttribute("aria-label", t(nowFav ? "encFavRemove" : "encFavAdd"));
    popFav(favBtn);
    if (encFilter === "favorites") renderEncGrid();
  });
  on(encOverlay, "click", (e) => { if (e.target === encOverlay) closeEncDetail(); });

  on(document.getElementById("encAskBtn"), "click", () => {
    if (!encCurrentPlant) return;
    lastPredictedClass = encCurrentPlant.key;
    closeEncDetail();
    goPage("chatbot");
    if (!chatStarted) startChat();
  });

  // ---------------------------------------------------------------------
  // Compare Plants — two dropdowns fed by the same /plants-all data,
  // rendered as a side-by-side table.
  // ---------------------------------------------------------------------
  function plantDisplayName(p, isAr) {
    return (isAr && p.arabic_name) ? p.arabic_name : ((isAr && p.scientific_name) ? p.scientific_name : (p.english_name || p.key));
  }
  function plantIcon(p) {
    return ENC_TOX_ICON[(p && p.toxicity_level) || "unknown"] || "🌱";
  }
  function plantThumb(p) {
    if (p && p.image_url) {
      const credit = p.image_credit ? ` title="${p.image_credit}"` : "";
      // NOTE: deliberately NOT setting crossorigin here -- Wikimedia's CORS
      // headers aren't reliable enough for the browser to guarantee a load,
      // and a broken image on-screen is worse than a missing one in the PDF.
      // The PDF export below skips this element instead (see ignoreElements).
      return `<img class="compare-thumb" src="${p.image_url}" alt=""${credit} loading="lazy">`;
    }
    return `<div class="compare-thumb compare-thumb-icon">${plantIcon(p)}</div>`;
  }
  function encPlantByKey(key) {
    return encPlants.find((p) => p.key === key);
  }
  function cmpJoin(arr) {
    return (arr && arr.length) ? arr.join(" · ") : null;
  }

  // Trusted source link for the comparison table -- prefers the
  // verified Arabic/Wikipedia link (reference_ar) when there is one, but
  // falls back to the English reference list instead of showing nothing,
  // since several plants only have the English sources filled in.
  function cmpSourcesHtml(p) {
    const wiki = (p.reference_ar && p.reference_ar[0]) || null;
    if (wiki) return `<a href="${wiki}" target="_blank" rel="noopener" class="cmp-source-link">Wikipedia</a>`;
    const fallback = (p.reference && p.reference[0]) || null;
    if (!fallback) return null;
    let host = fallback;
    try { host = new URL(fallback).hostname.replace("www.", ""); } catch (e) {}
    return `<a href="${fallback}" target="_blank" rel="noopener" class="cmp-source-link">${host}</a>`;
  }

  function populateCompareSelects() {
    const selA = document.getElementById("compareA");
    const selB = document.getElementById("compareB");
    if (!selA || !selB) return;
    const prevA = selA.value, prevB = selB.value;
    const isAr = currentLang === "ar";
    const opts = `<option value="">${t("comparePickPh")}</option>` +
      encPlants.map((p) => `<option value="${p.key}">${plantDisplayName(p, isAr)}</option>`).join("");
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    if (encPlants.some((p) => p.key === prevA)) selA.value = prevA;
    if (encPlants.some((p) => p.key === prevB)) selB.value = prevB;
  }

  function renderCompare() {
    const selA = document.getElementById("compareA");
    const selB = document.getElementById("compareB");
    const result = document.getElementById("compareResult");
    const empty = document.getElementById("compareEmpty");
    if (!selA || !selB || !result || !empty) return;
    const a = encPlantByKey(selA.value);
    const b = encPlantByKey(selB.value);

    if (!a || !b || a.key === b.key) {
      result.innerHTML = "";
      empty.style.display = "block";
      empty.querySelector("p").textContent = (selA.value && selA.value === selB.value) ? t("compareSamePlant") : t("comparePrompt");
      const dlBtn0 = document.getElementById("compareDownloadBtn");
      if (dlBtn0) dlBtn0.style.display = "none";
      return;
    }
    empty.style.display = "none";
    const dlBtn = document.getElementById("compareDownloadBtn");
    if (dlBtn) dlBtn.style.display = "block";

    const isAr = currentLang === "ar";
    const rows = [
      ["cmpSci", (p) => p.scientific_name || t("none")],
      ["cmpFamily", (p) => ((isAr && p.family_ar) ? p.family_ar : p.family) || t("none")],
      ["cmpToxicity", (p) => t(ENC_TOX_KEY[p.toxicity_level] || "toxLevelUnknown")],
      ["cmpMedicinal", (p) => (p.medicinal ? t("yes") : t("no"))],
      ["cmpHabitat", (p) => ((isAr && p.habitat_ar) ? p.habitat_ar : p.habitat) || t("none")],
      ["cmpCompounds", (p) => {
        if (!p.active_compounds || !p.active_compounds.length) return t("none");
        return p.active_compounds.map((c) => {
          const info = compoundGlossary[c];
          const title = info ? ` title="${esc((isAr ? info.ar : info.en) || "")}"` : "";
          return `<span${title}>${c}</span>`;
        }).join(" · ");
      }],
      ["cmpUses", (p) => cmpJoin((isAr && p.uses_ar && p.uses_ar.length) ? p.uses_ar : p.uses) || t("none")],
      ["cmpWarnings", (p) => ((isAr && p.warnings_ar) ? p.warnings_ar : p.warnings) || t("none"), true],
      ["cmpGrowing", (p) => ((isAr && p.growing_method_ar) ? p.growing_method_ar : p.growing_method) || t("none")],
      ["cmpCare", (p) => ((isAr && p.care_ar) ? p.care_ar : p.care) || t("none")],
      ["cmpPests", (p) => cmpJoin((isAr && p.common_pests_ar && p.common_pests_ar.length) ? p.common_pests_ar : p.common_pests) || t("none")],
      ["cmpDistribution", (p) => ((isAr && p.geographic_distribution_ar) ? p.geographic_distribution_ar : p.geographic_distribution) || t("none")],
      ["cmpDosage", (p) => ((isAr && p.safe_dosage_ar) ? p.safe_dosage_ar : p.safe_dosage) || t("none")],
      ["cmpSources", (p) => cmpSourcesHtml(p) || t("none")],
    ];

    let html = `<div class="compare-row compare-photos">
      <div class="compare-cell label"></div>
      <div class="compare-cell compare-photo-cell">${plantThumb(a)}</div>
      <div class="compare-cell compare-photo-cell">${plantThumb(b)}</div>
    </div>
    <div class="compare-row head">
      <div class="compare-cell label"></div>
      <div class="compare-cell">${plantIcon(a)} ${plantDisplayName(a, isAr)}</div>
      <div class="compare-cell">${plantIcon(b)} ${plantDisplayName(b, isAr)}</div>
    </div>`;

    rows.forEach(([key, getter, isWarn]) => {
      html += `<div class="compare-row">
        <div class="compare-cell label">${t(key)}</div>
        <div class="compare-cell${isWarn ? " warn" : ""}">${getter(a)}</div>
        <div class="compare-cell${isWarn ? " warn" : ""}">${getter(b)}</div>
      </div>`;
    });

    result.innerHTML = html;
  }

  on(document.getElementById("compareA"), "change", renderCompare);
  on(document.getElementById("compareB"), "change", renderCompare);

  on(document.getElementById("compareDownloadBtn"), "click", () => {
    // Switched from html2canvas/jsPDF to the browser's own Print dialog
    // (pick "Save as PDF" as the destination). html2canvas could not
    // reliably capture the cross-origin plant photos, and separately
    // re-measured text itself instead of using real browser text layout,
    // which produced the uneven letter/word spacing seen in earlier
    // exports. Printing the real page sidesteps both problems entirely.
    // The print-only CSS (see style.css) hides everything except the
    // comparison table itself.
    window.print();
  });

  // ---------------------------------------------------------------------
  // My Herbarium — a personal collection built from the local scan
  // history. Every distinct species the person has identified gets a
  // card (with how many times seen + first-found date); species from
  // the trained roster they haven't found yet show as a locked "?" card.
  // ---------------------------------------------------------------------
  function renderHerbarium() {
    const grid = document.getElementById("herbGrid");
    const empty = document.getElementById("herbEmpty");
    const fill = document.getElementById("herbProgressFill");
    const label = document.getElementById("herbProgressLabel");
    if (!grid || !empty || !fill || !label) return;

    const roster = allClassNames.length ? allClassNames : encPlants.map((p) => p.key);
    if (!roster.length) {
      grid.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    const hist = getHistory().filter((h) => h.status === "ok" && h.prediction);
    const discovered = {};
    hist.forEach((h) => {
      const key = h.prediction;
      if (!discovered[key]) discovered[key] = { count: 0, firstSeen: h.timestamp, lastEntry: h };
      discovered[key].count += 1;
      if (h.timestamp < discovered[key].firstSeen) discovered[key].firstSeen = h.timestamp;
      if (h.timestamp > (discovered[key].lastEntry.timestamp || 0)) discovered[key].lastEntry = h;
    });

    const discoveredCount = roster.filter((k) => discovered[k]).length;
    const total = roster.length;
    fill.style.width = total ? `${Math.round((discoveredCount / total) * 100)}%` : "0%";
    label.textContent = `${discoveredCount} / ${total} ${t("herbDiscovered")}`;
    empty.style.display = "none";

    const isAr = currentLang === "ar";
    grid.innerHTML = "";

    roster.forEach((key) => {
      const p = encPlantByKey(key);
      const entry = discovered[key];
      const card = document.createElement("div");

      if (entry) {
        const tox = (p && p.toxicity_level) || "unknown";
        const name = p ? plantDisplayName(p, isAr) : key;
        const sci = p ? (p.scientific_name || "") : "";
        const dateStr = new Date(entry.firstSeen).toLocaleDateString(isAr ? "ar" : "en", { year: "numeric", month: "short", day: "numeric" });
        card.className = "enc-card herb-card tox-" + tox;
        card.innerHTML = `
          <div class="enc-icon">${ENC_TOX_ICON[tox] || "🌿"}</div>
          <div class="enc-name">${name}</div>
          <div class="enc-sci">${sci}</div>
          <div class="enc-tox-label"><span>${t(ENC_TOX_KEY[tox] || "toxLevelUnknown")}</span><span class="herb-seen-count">×${entry.count}</span></div>
          <div class="herb-first-seen">${t("herbFirstSeen")}: ${dateStr}</div>
        `;
        card.addEventListener("click", () => {
          goPage("identify");
          renderResult(entry.lastEntry);
          const previewEl = document.getElementById("preview");
          if (previewEl && entry.lastEntry.image) {
            previewEl.src = entry.lastEntry.image;
            previewEl.style.display = "block";
          }
        });
      } else {
        card.className = "enc-card herb-card locked";
        card.innerHTML = `
          <div class="enc-icon">🔒</div>
          <div class="enc-name">?</div>
          <div class="enc-sci">${t("herbLocked")}</div>
        `;
      }
      grid.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------
  // Plant of the Day — deterministic pick (same plant all day, changes at
  // midnight) from the loaded species list. Purely educational spotlight,
  // clicking it opens the full Encyclopedia entry.
  // ---------------------------------------------------------------------
  function renderPlantOfDay() {
    const card = document.getElementById("potdCard");
    if (!card || !encPlants.length) return;

    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const p = encPlants[dayOfYear % encPlants.length];
    const isAr = currentLang === "ar";

    card.style.display = "block";
    card.style.cursor = "pointer";
    document.getElementById("potdName").textContent = plantDisplayName(p, isAr);
    document.getElementById("potdSci").textContent = p.scientific_name || "";
    const descText = (isAr && p.description_ar) ? p.description_ar : p.description;
    document.getElementById("potdDesc").textContent = descText || "";

    const imgEl = document.getElementById("potdImg");
    const iconEl = document.getElementById("potdIcon");
    if (p.image_url) {
      imgEl.src = p.image_url; imgEl.style.display = "block"; iconEl.style.display = "none";
    } else {
      iconEl.textContent = ENC_TOX_ICON[p.toxicity_level || "unknown"] || "🌱";
      imgEl.style.display = "none"; iconEl.style.display = "block";
    }

    card.onclick = () => { goPage("encyclopedia"); openEncDetail(p); };
  }

  // ---------------------------------------------------------------------
  // Learning Center — short practical guides. Content here is written
  // carefully and generally (not inventing region-specific claims we
  // haven't verified) rather than presented as medical/foraging advice.
  // ---------------------------------------------------------------------
  const ARTICLES = {
    "identify-similar": {
      icon: "🔍",
      category: "identify",
      title_en: "How to tell similar-looking plants apart",
      title_ar: "كيف تميّزي بين النباتات المتشابهة؟",
      teaser_en: "Leaves alone can fool you — here's what actually helps.",
      teaser_ar: "الأوراق لحالها ممكن تخدعك — هاي الأشياء يلي فعلاً بتفرق.",
      body_en: [
        "Two plants can have almost identical leaf shape and still be completely different species — this app's own confusion pairs (e.g. Justicia vs. haritoki, or centella vs. thankuni, which are actually the same species) show how easy it is to mix leaves up from a photo alone.",
        "Look at more than the leaf: check the arrangement (opposite vs. alternate), the margin (smooth, toothed, lobed), venation pattern, and the stem — woody vs. soft, square vs. round (mint-family plants have square stems).",
        "Flowers and fruit are usually far more distinctive than leaves. If you can wait for the plant to flower or fruit before deciding, do that.",
        "Habitat and growth form matter too — a succulent in a pot is a very different candidate list than a vine climbing a fence.",
        "Use this app's Compare page to put two candidates side by side on the same fields, and treat any single photo ID (from this app or otherwise) as a starting point to verify, not a final answer — especially if toxicity is a possibility.",
      ],
      body_ar: [
        "نباتين ممكن يكون شكل ورقهم متطابق تقريباً وهم أنواع مختلفة تماماً — أزواج الالتباس بنفس هاد التطبيق (متل Justicia مقابل الهليلج، أو السنتيلا مقابل ثانكوني يلي هم أصلاً نفس النوع) بتوري كيف من السهل يختلط الأمر بالاعتماد على صورة وحدة بس.",
        "دقّق بأكتر من الورقة: ترتيبها (متقابلة أو متبادلة)، حوافها (ملساء، مسنّنة، مفصّصة)، نمط العروق، والساق — خشبية أو طرية، مربّعة أو دائرية (نباتات الفصيلة الشفوية زي النعناع عندها ساق مربّعة).",
        "الأزهار والثمار عادة بتفرّق أكتر بكتير من الورق. لو تقدر تستني النبتة تزهر أو تثمر قبل ما تقرر، هاد أفضل.",
        "الموطن وشكل النمو كمان مهم — نبات عصاري بأصيص شي مختلف تماماً عن متسلّق على سياج.",
        "استخدم صفحة \"مقارنة\" بهاد التطبيق لتحط احتمالين جنب بعض بنفس الحقول، وخلي أي تصنيف بصورة وحدة (من هاد التطبيق أو غيره) نقطة بداية للتأكد، مو جواب نهائي — خصوصاً لو في احتمال سمّية.",
      ],
    },
    "regional-medicinal": {
      icon: "🌿",
      category: "regional",
      title_en: "Medicinal plants common in our region",
      title_ar: "نباتات طبية شائعة بمنطقتنا",
      teaser_en: "Several of the 25 species are Mediterranean/Levant natives you likely recognize.",
      teaser_ar: "كذا نوع من الـ25 نبات أصله من حوض المتوسط والشام، على الأغلب بتعرفهم.",
      body_en: [
        "Several species in this project's database are native to or long-cultivated across the Mediterranean and Levant, based on the documented habitat/distribution for each (see their Encyclopedia entries): Za'atar (Origanum syriacum) is one of the most iconic Levantine herbs. Rosemary, sage, and lavender are all Mediterranean natives widely grown as garden and culinary herbs across the region. Chamomile is native to Europe and West Asia and grows widely as a wild and cultivated plant.",
        "Mint species are cultivated worldwide, including extensively across the Middle East, for tea and cooking.",
        "This is a general note based on documented native ranges, not a claim about which specific plants grow wild in any one country or governorate — always verify locally before assuming a wild plant you find is one of these species.",
      ],
      body_ar: [
        "كذا نوع من قاعدة بيانات هاد المشروع أصله من حوض المتوسط والشام أو انزرع فيها منذ زمن طويل، بناءً على الموطن والانتشار الجغرافي الموثّق لكل نبات (شوف صفحته بالموسوعة): الزعتر (Origanum syriacum) من أشهر أعشاب بلاد الشام. الروزماري والمريمية والخزامى كلهم أصلهم من حوض المتوسط ومزروعين على نطاق واسع كأعشاب حدائق وطبخ بالمنطقة. البابونج أصله من أوروبا وغرب آسيا وينمو برّياً ومزروعاً على نطاق واسع.",
        "أنواع النعناع مزروعة حول العالم، وبكثافة بالشرق الأوسط، للشاي والطبخ.",
        "هاي ملاحظة عامة مبنية على النطاق الأصلي الموثّق، مش ادّعاء إنه هاي النباتات بالتحديد بتنمو برّياً بأي بلد أو محافظة معيّنة — دائماً تأكد محلياً قبل ما تفترض إنه نبات برّي لقيته هو نفس النوع."
      ],
    },
    "toxic-warning": {
      icon: "☠️",
      category: "safety",
      title_en: "Toxic plants to watch out for",
      title_ar: "نباتات سامة لازم تنتبه إلها",
      teaser_en: "Some of the most dangerous look completely harmless.",
      teaser_ar: "بعض أخطرهم شكله بريء تماماً.",
      body_en: [
        "Of the 25 species this app recognizes, several are classified as poisonous in the database — oleander, deadly nightshade, colocynth, devil's backbone, and pathorkuchi (Kalanchoe pinnata) among them. Check each plant's Toxicity badge and Warnings section in the Encyclopedia before assuming anything is safe.",
        "Oleander is a textbook example of the danger: an attractive flowering shrub, planted widely as ornamental landscaping, where every part of the plant contains cardiac glycosides that can be fatal if ingested.",
        "Deadly nightshade's berries can look tempting (dark, glossy, superficially like small grapes or blueberries) but contain tropane alkaloids that are highly toxic even in small amounts.",
        "General rule that applies regardless of what any app says: never taste, chew, or ingest any wild or unfamiliar plant material, and keep unidentified plants away from children and pets. If ingestion happens or is suspected, contact poison control or emergency services immediately — don't wait to look it up.",
      ],
      body_ar: [
        "من ضمن الـ25 نبات يلي التطبيق مدرَّب عليها، كذا نوع مصنَّف سام بقاعدة البيانات — الدفلة، ست الحسن، الحنظل، عمود الشيطان، وPathorkuchi (Kalanchoe pinnata) من بينهم. تأكد من بادج درجة السمّية وقسم التحذيرات لكل نبات بالموسوعة قبل ما تفترض إنه أي نبات آمن.",
        "الدفلة مثال كلاسيكي عالخطورة: شجيرة مزهرة جذّابة، منزرعة بكثرة كنبتة زينة، بس كل جزء فيها يحتوي على غليكوسيدات قلبية ممكن تكون قاتلة لو انبلعت.",
        "توت ست الحسن ممكن يبين مغري (غامق، لمّاع، شكله شبه عنب صغير أو توت أزرق) بس فيه قلويدات تروبانية شديدة السمّية حتى بكميات قليلة.",
        "قاعدة عامة بغض النظر عن أي تطبيق: ما تذوق أو تمضغ أو تبلع أي نبات برّي أو غير معروف، وخلي النباتات غير المؤكّدة بعيدة عن الأطفال والحيوانات الأليفة. لو صار ابتلاع أو في شك فيه، تواصل فوراً مع مركز السموم أو الطوارئ — ما تستنّ تدوّر بالإنترنت.",
      ],
    },
    "safe-collection": {
      icon: "🧤",
      category: "collection",
      title_en: "How to collect plants safely and responsibly",
      title_ar: "كيف تجمع/تقطف النباتات بطريقة صحيحة وآمنة",
      teaser_en: "Safety and sustainability matter more than the photo.",
      teaser_ar: "السلامة والاستدامة أهم من الصورة.",
      body_en: [
        "Confirm identity with more than one source before handling any wild plant beyond taking a photo — this app's prediction, cross-checked against the Encyclopedia entry and, ideally, an experienced person or field guide for your area.",
        "Wear gloves when handling anything you haven't positively identified as safe — several plants in this database (like devil's backbone) can irritate skin on contact through their sap alone.",
        "Collect away from roadsides, industrial areas, and sprayed agricultural fields to avoid contamination, and never take more than a small amount from any single wild population — over-harvesting can damage local plant communities.",
        "Note the season and time of day appropriate for the part you want (leaves, flowers, roots) — this varies by species and affects both the plant's ability to recover and the concentration of its compounds.",
        "Respect protected areas and private property, and check local regulations — some wild plants are protected by conservation law depending on the region.",
      ],
      body_ar: [
        "تأكد من هوية النبات من أكتر من مصدر قبل ما تتعامل مع أي نبات برّي (مو بس تصوّره) — نتيجة هاد التطبيق، مقارنة بصفحته بالموسوعة، ويُفضّل كمان شخص خبير أو دليل ميداني لمنطقتك.",
        "البس قفازات لما تتعامل مع أي نبات ما تأكدت إنه آمن — كذا نبات بهاي القاعدة (زي عمود الشيطان) ممكن يهيّج الجلد بمجرد ملامسة عصارته.",
        "اجمع بعيداً عن جوانب الطرق والمناطق الصناعية والحقول المرشوشة لتجنّب التلوث، وما تاخذ كمية كبيرة من مجتمع نباتي برّي وحد — القطف الجائر ممكن يضر النباتات المحلية.",
        "انتبه للموسم والوقت المناسب حسب الجزء يلي بدك ياه (ورق، أزهار، جذور) — بيختلف حسب النوع وبيأثر على قدرة النبتة ع التعافي وتركيز مركّباتها.",
        "احترم المناطق المحمية والملكية الخاصة، وتأكد من الأنظمة المحلية — بعض النباتات البرّية محمية بقوانين حماية البيئة حسب المنطقة.",
      ],
    },
  };

  const LEARN_CATEGORIES = [
    { key: "identify", icon: "🔍", label_en: "Identification", label_ar: "التعرف والتمييز" },
    { key: "regional", icon: "🌿", label_en: "Regional plants", label_ar: "نباتات المنطقة" },
    { key: "safety", icon: "☠️", label_en: "Safety & toxicity", label_ar: "السلامة والسمّية" },
    { key: "collection", icon: "🧤", label_en: "Responsible collection", label_ar: "القطف المسؤول" },
  ];
  let learnFilterKey = "all";

  function renderLearnFilters() {
    const container = document.getElementById("learnFilters");
    if (!container) return;
    const isAr = currentLang === "ar";
    let html = `<button class="cal-filter-chip${learnFilterKey === "all" ? " active" : ""}" data-learn-filter="all">${t("calendarAll")}</button>`;
    LEARN_CATEGORIES.forEach((c) => {
      html += `<button class="cal-filter-chip${learnFilterKey === c.key ? " active" : ""}" data-learn-filter="${c.key}">${c.icon} ${isAr ? c.label_ar : c.label_en}</button>`;
    });
    container.innerHTML = html;
    container.querySelectorAll("[data-learn-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        learnFilterKey = btn.getAttribute("data-learn-filter");
        renderLearnFilters();
        renderLearningCenter();
      });
    });
  }

  function renderLearningCenter() {
    const grid = document.getElementById("articleGrid");
    if (!grid) return;
    const isAr = currentLang === "ar";
    grid.innerHTML = "";
    Object.entries(ARTICLES)
      .filter(([, a]) => learnFilterKey === "all" || a.category === learnFilterKey)
      .forEach(([key, a]) => {
        const card = document.createElement("div");
        card.className = "enc-card";
        card.innerHTML = `
          <div class="enc-icon">${a.icon}</div>
          <div class="enc-name">${isAr ? a.title_ar : a.title_en}</div>
          <div class="enc-sci">${isAr ? a.teaser_ar : a.teaser_en}</div>
        `;
        card.addEventListener("click", () => openArticle(key));
        grid.appendChild(card);
      });
  }

  function openArticle(key) {
    const a = ARTICLES[key];
    if (!a) return;
    const isAr = currentLang === "ar";
    document.getElementById("articleIcon").textContent = a.icon;
    document.getElementById("articleTitle").textContent = isAr ? a.title_ar : a.title_en;
    const body = (isAr ? a.body_ar : a.body_en).map((p) => `<p class="info-text" style="margin-bottom:10px">${p}</p>`).join("");
    document.getElementById("articleBody").innerHTML = body;
    const overlay = document.getElementById("articleOverlay");
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
  }
  function closeArticle() {
    const overlay = document.getElementById("articleOverlay");
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
  }
  on(document.getElementById("articleCloseBtn"), "click", closeArticle);
  on(document.getElementById("articleOverlay"), "click", (e) => {
    if (e.target.id === "articleOverlay") closeArticle();
  });

  function openModelInfo() {
    const overlay = document.getElementById("modelInfoOverlay");
    if (!overlay) return;
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
  }
  function closeModelInfo() {
    const overlay = document.getElementById("modelInfoOverlay");
    if (!overlay) return;
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
  }
  on(document.getElementById("modelInfoBtn"), "click", openModelInfo);
  on(document.getElementById("modelInfoCloseBtn"), "click", closeModelInfo);
  on(document.getElementById("modelInfoOverlay"), "click", (e) => {
    if (e.target.id === "modelInfoOverlay") closeModelInfo();
  });

  // ---------------------------------------------------------------------
  // My Growing Plan — a personal reminder for plant CARE tasks (watering,
  // fertilizing, pruning, harvest), covering all 25 species, not a tea-
  // drinking schedule (that's what this used to be -- product decision
  // 2026-07-26 changed it to a general growing/care checklist since most
  // users have plants to tend, not just ones they drink). Stored locally
  // under a fresh key so old tea-routine entries don't render wrong under
  // the new shape; "done" resets automatically each new day.
  // ---------------------------------------------------------------------
  const GROWPLAN_KEY = "plantai_growplan";
  const GROWPLAN_TASK_ORDER = { watering: 0, fertilizing: 1, pruning: 2, harvest: 3 };
  const GROWPLAN_TASK_ICON = { watering: "💧", fertilizing: "🌱", pruning: "✂️", harvest: "🌾" };

  function getGrowPlan() {
    try { return JSON.parse(localStorage.getItem(GROWPLAN_KEY)) || []; } catch (e) { return []; }
  }
  function saveGrowPlan(list) {
    try { localStorage.setItem(GROWPLAN_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function populateGrowPlanPlantSelect() {
    const sel = document.getElementById("growPlanPlantSelect");
    if (!sel || !encPlants.length) return;
    const isAr = currentLang === "ar";
    sel.innerHTML = encPlants.map((p) => `<option value="${p.key}">${plantIcon(p)} ${plantDisplayName(p, isAr)}</option>`).join("");
  }

  function renderGrowPlan() {
    const list = getGrowPlan();
    const listEl = document.getElementById("growPlanTodayList");
    const emptyEl = document.getElementById("growPlanEmpty");
    if (!listEl || !emptyEl) return;
    if (!list.length) {
      listEl.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";
    const isAr = currentLang === "ar";
    const today = todayStr();
    const sorted = [...list].sort((a, b) => (GROWPLAN_TASK_ORDER[a.task] || 0) - (GROWPLAN_TASK_ORDER[b.task] || 0));

    listEl.innerHTML = sorted.map((r) => {
      const p = encPlantByKey(r.plantKey);
      if (!p) return "";
      const name = plantDisplayName(p, isAr);
      const tip = (isAr && p.care_ar) ? p.care_ar : p.care;
      const done = r.doneDate === today;
      return `<div class="routine-row ${done ? "done" : ""}">
        <label class="routine-check">
          <input type="checkbox" data-growplan-toggle="${r.id}" ${done ? "checked" : ""}>
          <span>${GROWPLAN_TASK_ICON[r.task] || ""} <b>${name}</b></span>
        </label>
        ${tip ? `<div class="routine-prep">${t("growPlanTipPrefix")} ${tip}</div>` : ""}
        <button class="routine-remove" data-growplan-remove="${r.id}">${t("growPlanRemove")}</button>
      </div>`;
    }).join("");
  }

  on(document.getElementById("growPlanAddBtn"), "click", () => {
    const plantSel = document.getElementById("growPlanPlantSelect");
    const taskSel = document.getElementById("growPlanTaskSelect");
    if (!plantSel || !plantSel.value) return;
    const list = getGrowPlan();
    list.push({ id: "g" + Date.now(), plantKey: plantSel.value, task: taskSel.value, doneDate: null });
    saveGrowPlan(list);
    renderGrowPlan();
  });

  on(document.getElementById("growPlanTodayList"), "click", (e) => {
    const toggle = e.target.closest("[data-growplan-toggle]");
    if (toggle) {
      const id = toggle.getAttribute("data-growplan-toggle");
      const list = getGrowPlan();
      const entry = list.find((r) => r.id === id);
      if (entry) entry.doneDate = (entry.doneDate === todayStr()) ? null : todayStr();
      saveGrowPlan(list);
      renderGrowPlan();
      return;
    }
    const remove = e.target.closest("[data-growplan-remove]");
    if (remove) {
      const id = remove.getAttribute("data-growplan-remove");
      saveGrowPlan(getGrowPlan().filter((r) => r.id !== id));
      renderGrowPlan();
    }
  });

  // ---------------------------------------------------------------------
  // Herb Center tabs (Learning / My Growing Plan) -- simple show/hide,
  // no data dependency between the two.
  // ---------------------------------------------------------------------
  document.querySelectorAll("[data-learn-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-learn-tab");
      document.querySelectorAll("[data-learn-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll("[data-learn-panel]").forEach((p) => p.classList.toggle("on", p.getAttribute("data-learn-panel") === tab));
    });
  });

  // ---------------------------------------------------------------------
  // Herb Calendar — grouped by general plant TYPE (tree / woody shrub /
  // herbaceous / rhizome / succulent). Planting/harvest windows are MONTH
  // RANGES derived from each category's seasonal guidance below, never
  // an invented single day -- exact timing depends on local climate, so
  // a favorable month is as precise as we can honestly claim. Categories
  // without a genuine seasonal harvest window (continuous harvest, or
  // "takes years to mature") keep harvest_months as null and explain why
  // in text instead of showing a fake color on the grid.
  // ---------------------------------------------------------------------
  const CALENDAR_CATEGORIES = [
    {
      key: "trees", icon: "🌳",
      label_en: "Trees", label_ar: "أشجار",
      planting_en: "Plant young saplings in mild weather — spring in temperate climates, or the start of the rainy season in the tropics.",
      planting_ar: "ازرع شتلات صغيرة بجو معتدل — الربيع بالمناخات المعتدلة، أو بداية موسم الأمطار بالمناطق الاستوائية.",
      harvest_en: "Harvest fruit, bark, or leaves once the tree is established — this can take a few years for some species, so there's no single harvest month.",
      harvest_ar: "احصد الثمار أو اللحاء أو الورق بعد ما تترسّخ الشجرة — هذا ممكن ياخذ كم سنة لبعض الأنواع، فما في شهر حصاد واحد محدَّد.",
      planting_months: [3, 4, 5],
      harvest_months: null,
      plants: ["Lemon", "bohera", "haritoki", "terminalia_arjuna", "neem", "phyllanthus"],
    },
    {
      key: "shrubs", icon: "🌿",
      label_en: "Woody shrubs & perennials", label_ar: "شجيرات خشبية ومعمّرات",
      planting_en: "Best started in spring from cuttings or seed.",
      planting_ar: "أفضل بلش لها بالربيع من عقل أو بذور.",
      harvest_en: "Once established, trim/harvest leaves or flowers through the growing season, avoiding the coldest month — a broad window, not one specific month.",
      harvest_ar: "بعد ما تترسّخ، اقطف الورق أو الأزهار خلال موسم النمو، وتجنّب أبرد شهر بالسنة — نافذة واسعة، مش شهر واحد محدَّد.",
      planting_months: [3, 4, 5],
      harvest_months: null,
      plants: ["Justicia", "hibiscus_rosa", "oleander", "rosemary", "khuzama_lavender"],
    },
    {
      key: "herbs", icon: "🌱",
      label_en: "Herbaceous annuals & fast perennials", label_ar: "أعشاب حولية ومعمّرات سريعة",
      planting_en: "Sow or plant in spring; cool-season types (like chamomile) can also be sown in autumn.",
      planting_ar: "ازرع أو ابذر بالربيع؛ الأنواع يلي بتحب الجو البارد (زي البابونج) ممكن كمان تتزرع بالخريف.",
      harvest_en: "Harvest leaves continuously once the plant is established; harvest flowers right as they open — ongoing, not one specific month.",
      harvest_ar: "اقطف الورق باستمرار بعد ما تترسّخ النبتة؛ اقطف الأزهار فور ما تتفتّح — مستمر، مش شهر واحد محدَّد.",
      planting_months: [3, 4, 5, 9, 10, 11],
      harvest_months: null,
      plants: ["Mint", "Za'atar", "centella", "thankuni", "chamomile", "colocynth", "deadly_nightshade", "sage", "tulsi"],
    },
    {
      key: "rhizome", icon: "🫚",
      label_en: "Rhizomes & roots", label_ar: "جذور وريزومات",
      planting_en: "Plant rhizome pieces in spring once the soil has warmed up.",
      planting_ar: "ازرع قطع الريزوم بالربيع بعد ما تدفّى التربة.",
      harvest_en: "Harvest in autumn once the foliage begins to die back.",
      harvest_ar: "احصد بالخريف بعد ما يبلش الورق يذبل.",
      planting_months: [3, 4, 5],
      harvest_months: [9, 10, 11],
      plants: ["zanjabeel_ginger"],
    },
    {
      key: "succulents", icon: "🪴",
      label_en: "Succulents", label_ar: "نباتات عصارية",
      planting_en: "Propagate from cuttings/offsets almost any time indoors; plant outdoors in the warm season.",
      planting_ar: "أكثر من عقل أو فسائل بأي وقت تقريباً بالداخل؛ ازرع بالخارج بالموسم الدافئ.",
      harvest_en: "Leaves/pads can be harvested anytime once the plant is well established — not tied to a specific month.",
      harvest_ar: "الأوراق ممكن تُقطف بأي وقت بعد ما تترسّخ النبتة كويس — مش مرتبط بشهر محدَّد.",
      planting_months: [5, 6, 7, 8, 9],
      harvest_months: null,
      plants: ["aloevera", "pathorkuchi", "devilbackbone"],
    },
  ];

  let calViewYear, calViewMonth; // calViewMonth is 0-11 (JS Date convention)
  let calFilterKey = "all";
  let calSelectedDate = null; // { y, m (0-11), d } or null
  let calSelectedPlantKey = null;
  (function calInitState() {
    const now = new Date();
    calViewYear = now.getFullYear();
    calViewMonth = now.getMonth();
  })();

  function calActiveCategories() {
    return calFilterKey === "all" ? CALENDAR_CATEGORIES : CALENDAR_CATEGORIES.filter((c) => c.key === calFilterKey);
  }

  // month is 1-12
  function calMonthActivity(month, categories) {
    let planting = false, harvest = false;
    categories.forEach((c) => {
      if (c.planting_months && c.planting_months.includes(month)) planting = true;
      if (c.harvest_months && c.harvest_months.includes(month)) harvest = true;
    });
    return { planting, harvest };
  }

  function calPlantsForMonth(month, categories) {
    const keys = [];
    categories.forEach((c) => {
      const active = (c.planting_months && c.planting_months.includes(month)) || (c.harvest_months && c.harvest_months.includes(month));
      if (active) keys.push(...c.plants);
    });
    return [...new Set(keys)].map((k) => encPlantByKey(k)).filter(Boolean);
  }

  function renderCalFilters() {
    const container = document.getElementById("calFilters");
    if (!container) return;
    const isAr = currentLang === "ar";
    let html = `<button class="cal-filter-chip${calFilterKey === "all" ? " active" : ""}" data-cal-filter="all">${t("calendarAll")}</button>`;
    CALENDAR_CATEGORIES.forEach((c) => {
      html += `<button class="cal-filter-chip${calFilterKey === c.key ? " active" : ""}" data-cal-filter="${c.key}">${c.icon} ${isAr ? c.label_ar : c.label_en}</button>`;
    });
    container.innerHTML = html;
    container.querySelectorAll("[data-cal-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        calFilterKey = btn.getAttribute("data-cal-filter");
        renderCalFilters();
        renderCalGrid();
        renderCalPanel();
      });
    });
  }

  function renderCalWeekdays() {
    const container = document.getElementById("calWeekdays");
    if (!container) return;
    const locale = currentLang === "ar" ? "ar" : "en";
    const base = new Date(2023, 0, 1); // a known Sunday
    let html = "";
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      html += `<span>${d.toLocaleDateString(locale, { weekday: "short" })}</span>`;
    }
    container.innerHTML = html;
  }

  function renderCalMonthLabel() {
    const el = document.getElementById("calMonthLabel");
    if (!el) return;
    const d = new Date(calViewYear, calViewMonth, 1);
    el.textContent = d.toLocaleDateString(currentLang === "ar" ? "ar" : "en", { month: "long", year: "numeric" });
  }

  function renderCalGrid() {
    const container = document.getElementById("calGrid");
    if (!container) return;
    const categories = calActiveCategories();
    const firstOfMonth = new Date(calViewYear, calViewMonth, 1);
    const startOffset = firstOfMonth.getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calViewYear, calViewMonth, 0).getDate();
    const today = new Date();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    let html = "";
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startOffset + 1;
      let cellMonthIdx = calViewMonth, cellDay, muted = false;
      if (dayNum < 1) { cellDay = daysInPrevMonth + dayNum; cellMonthIdx = calViewMonth - 1; muted = true; }
      else if (dayNum > daysInMonth) { cellDay = dayNum - daysInMonth; cellMonthIdx = calViewMonth + 1; muted = true; }
      else { cellDay = dayNum; }

      let normYear = calViewYear, normMonth = cellMonthIdx;
      if (normMonth < 0) { normMonth = 11; normYear -= 1; }
      if (normMonth > 11) { normMonth = 0; normYear += 1; }

      const activity = muted ? { planting: false, harvest: false } : calMonthActivity(normMonth + 1, categories);
      const isToday = !muted && normYear === today.getFullYear() && normMonth === today.getMonth() && cellDay === today.getDate();
      const isSelected = calSelectedDate && calSelectedDate.y === normYear && calSelectedDate.m === normMonth && calSelectedDate.d === cellDay;

      let dots = "";
      if (activity.planting) dots += `<span class="cal-dot planting"></span>`;
      if (activity.harvest) dots += `<span class="cal-dot harvest"></span>`;

      html += `<div class="cal-day${muted ? " muted" : ""}${isToday ? " today" : ""}${isSelected ? " selected" : ""}" data-y="${normYear}" data-m="${normMonth}" data-d="${cellDay}">
        <span>${cellDay}</span><div class="cal-day-dots">${dots}</div>
      </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll(".cal-day:not(.muted)").forEach((cell) => {
      cell.addEventListener("click", () => {
        calSelectedDate = { y: +cell.dataset.y, m: +cell.dataset.m, d: +cell.dataset.d };
        calSelectedPlantKey = null;
        renderCalGrid();
        renderCalPanel();
      });
    });
  }

  function renderCalPanel() {
    const panel = document.getElementById("calPanel");
    if (!panel) return;
    const isAr = currentLang === "ar";

    if (!calSelectedDate) {
      panel.innerHTML = `<div class="cal-panel-prompt">📅 ${t("calendarPickDay")}</div>`;
      return;
    }

    const categories = calActiveCategories();
    const monthNum1based = calSelectedDate.m + 1;
    const dateLabel = new Date(calSelectedDate.y, calSelectedDate.m, calSelectedDate.d)
      .toLocaleDateString(isAr ? "ar" : "en", { day: "numeric", month: "long", year: "numeric" });

    if (calSelectedPlantKey) {
      const p = encPlantByKey(calSelectedPlantKey);
      if (!p) { calSelectedPlantKey = null; renderCalPanel(); return; }
      const fav = isFavorite(p.key);

      let html = `<button class="cal-panel-back" id="calBackBtn">${isAr ? "‹ رجوع" : "‹ Back"}</button>`;
      html += `<div class="cal-panel-detail-head">`;
      html += p.image_url ? `<img class="cal-panel-detail-img" src="${p.image_url}" alt="">` : `<div class="cal-panel-detail-icon">${plantIcon(p)}</div>`;
      html += `<div><div class="cal-panel-detail-name">${plantDisplayName(p, isAr)}</div>${p.scientific_name ? `<div class="cal-panel-detail-sci">${p.scientific_name}</div>` : ""}</div>`;
      html += `</div>`;

      const growing = (isAr && p.growing_method_ar) ? p.growing_method_ar : p.growing_method;
      if (growing) html += `<div class="chat-section"><span class="chat-section-label">${t("chatSectionGrow")}</span>${growing}</div>`;

      const care = (isAr && p.care_ar) ? p.care_ar : p.care;
      if (care) html += `<div class="chat-section"><span class="chat-section-label">${t("chatCareLabel")}</span>${care}</div>`;

      const habitat = (isAr && p.habitat_ar) ? p.habitat_ar : p.habitat;
      if (habitat) html += `<div class="chat-section"><span class="chat-section-label">🌍 ${t("attrHabitat")}</span>${habitat}</div>`;

      html += `<button class="chat-quick-chip" id="calFavBtn" style="margin-top:8px">${fav ? "★" : "☆"} ${t(fav ? "encFavRemove" : "encFavAdd")}</button>`;

      panel.innerHTML = html;
      document.getElementById("calBackBtn").addEventListener("click", () => { calSelectedPlantKey = null; renderCalPanel(); });
      const favBtn = document.getElementById("calFavBtn");
      if (favBtn) favBtn.addEventListener("click", () => {
        toggleFavorite(p.key);
        popFav(favBtn);
        renderHerbarium();
        setTimeout(renderCalPanel, 260);
      });
      return;
    }

    const plants = calPlantsForMonth(monthNum1based, categories);
    let html = `<div class="cal-panel-date">📅 ${dateLabel}</div>`;
    if (!plants.length) {
      html += `<div class="cal-panel-sub">${t("calendarNoPlants")}</div>`;
    } else {
      html += `<div class="cal-panel-sub">${t("calendarSuitablePlants")}</div><div class="cal-panel-plants">`;
      plants.forEach((p) => {
        html += `<button class="cal-panel-plant-btn" data-plant-key="${p.key}"><span class="cal-panel-plant-icon">${plantIcon(p)}</span><span>${plantDisplayName(p, isAr)}</span></button>`;
      });
      html += `</div>`;
    }
    panel.innerHTML = html;
    panel.querySelectorAll("[data-plant-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        calSelectedPlantKey = btn.getAttribute("data-plant-key");
        renderCalPanel();
      });
    });
  }

  on(document.getElementById("calPrevBtn"), "click", () => {
    calViewMonth -= 1;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
    renderCalMonthLabel();
    renderCalGrid();
  });
  on(document.getElementById("calNextBtn"), "click", () => {
    calViewMonth += 1;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
    renderCalMonthLabel();
    renderCalGrid();
  });
  on(document.getElementById("calTodayBtn"), "click", () => {
    const now = new Date();
    calViewYear = now.getFullYear();
    calViewMonth = now.getMonth();
    calSelectedDate = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    calSelectedPlantKey = null;
    renderCalMonthLabel();
    renderCalGrid();
    renderCalPanel();
  });

  function renderCalendar() {
    if (!encPlants.length) return;
    renderCalFilters();
    renderCalWeekdays();
    renderCalMonthLabel();
    renderCalGrid();
    renderCalPanel();
  }

  // ---------------------------------------------------------------------
  // Drug interactions are now shown per-plant inside the encyclopedia
  // detail modal (see openEncDetail's encInteractions block below) rather
  // than as one standalone list -- see product decision 2026-07-26.
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // AI Dashboard — live usage stats from this app (via /dashboard-stats)
  // plus the offline evaluation numbers (Precision/Recall/F1/accuracy)
  // the project owner fills into MODEL_METRICS in app.py.
  // ---------------------------------------------------------------------
  let dashData = null;

  function loadDashboard() {
    fetch("/dashboard-stats")
      .then((r) => r.json())
      .then((d) => { dashData = d; renderDashboard(); })
      .catch(() => {});
  }

  function fmtMetric(v, isPercentAlready) {
    if (v === null || v === undefined) return t("dashNotComputed");
    return isPercentAlready ? `${v}%` : `${(v * 100).toFixed(1)}%`;
  }

  // Gentle "settle" count-up for plain integer stats (Apple/iOS-style spring
  // physics: eases out with a very slight overshoot before landing exactly
  // on the target, instead of snapping the number in instantly).
  const _animatedEls = new WeakSet();
  function animateNumberTo(el, target) {
    if (!el || typeof target !== "number" || isNaN(target)) {
      if (el) el.textContent = target;
      return;
    }
    if (_animatedEls.has(el) && el.dataset.animTarget === String(target)) return;
    _animatedEls.add(el);
    el.dataset.animTarget = String(target);
    const start = 0;
    const dur = 700;
    const t0 = performance.now();
    function frame(now) {
      const p = Math.min((now - t0) / dur, 1);
      const eased = p < 1 ? 1 - Math.pow(1 - p, 3) : 1;
      const overshoot = p < 0.85 ? 0 : Math.sin((p - 0.85) / 0.15 * Math.PI) * 0.02;
      el.textContent = Math.round(start + (target - start) * Math.min(eased + overshoot, 1.02));
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = target;
    }
    requestAnimationFrame(frame);
  }

  function renderDashboard() {
    if (!dashData) return;
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setNum = (id, val) => { const el = document.getElementById(id); if (el && typeof val === "number") animateNumberTo(el, val); else if (el) el.textContent = val; };

    setNum("dashSpecies", dashData.num_species ?? "—");
    setText("dashDocumented", dashData.num_documented_species ?? "—");
    setNum("dashTotalScans", dashData.total_predictions ?? 0);
    setText("dashAccuracy", fmtMetric(dashData.metrics?.test_accuracy, true));
    setText("dashPrecision", fmtMetric(dashData.metrics?.precision_macro, false));
    setText("dashRecall", fmtMetric(dashData.metrics?.recall_macro, false));
    setText("dashF1", fmtMetric(dashData.metrics?.f1_macro, false));
    setText("dashTrainingImages", dashData.metrics?.num_training_images ?? t("dashNotComputed"));
    setText("dashDevice", (dashData.device || "—").toUpperCase());

    const w = dashData.ensemble_weights || {};
    const ensembleParts = Object.entries(w).map(([k, v]) => `${Math.round(v * 100)}% ${k}`);
    setText("dashEnsemble", ensembleParts.join(" + ") || "—");

    const breakdown = document.getElementById("dashBreakdown");
    const noScans = document.getElementById("dashNoScans");
    if (!breakdown || !noScans) return;

    const total = dashData.total_predictions || 0;
    if (!total) {
      breakdown.innerHTML = "";
      noScans.style.display = "block";
      return;
    }
    noScans.style.display = "none";

    const rows = [
      ["dashConfident", dashData.confident, "confident"],
      ["dashLowConf", dashData.low_confidence, "low"],
      ["dashUnknown", dashData.unknown, "unknown"],
      ["dashNotAPlant", dashData.not_a_plant, "not-a-plant"],
    ];
    breakdown.innerHTML = rows.map(([labelKey, count, cls]) => {
      const pct = total ? Math.round((count / total) * 100) : 0;
      return `<div class="dash-bar-row">
        <div class="dash-bar-label"><span>${t(labelKey)}</span><span>${count} (${pct}%)</span></div>
        <div class="dash-bar-track"><i class="${cls}" style="width:${pct}%"></i></div>
      </div>`;
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Home (landing page) — real usage stats + the most recent real
  // analysis from local history. No decorative/fake data.
  // ---------------------------------------------------------------------
  function loadHomeStats() {
    ["hsSpecies", "hsToxic", "hsMedicinal", "hsAccuracy", "hsSpeed"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<span class="skeleton" style="display:inline-block;width:36px;height:14px;vertical-align:middle;"></span>`;
    });
    fetch("/dashboard-stats")
      .then((r) => r.json())
      .then((d) => {
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const setNum = (id, val) => { const el = document.getElementById(id); if (el && typeof val === "number") animateNumberTo(el, val); else if (el) el.textContent = val; };
        setNum("hsSpecies", d.num_species ?? "—");
        setNum("hsToxic", d.num_toxic_species ?? "—");
        setNum("hsMedicinal", d.num_medicinal_species ?? "—");
        setText("hsAccuracy", (d.metrics && d.metrics.test_accuracy != null) ? d.metrics.test_accuracy + "%" : t("dashNotComputed"));
        setText("hsSpeed", d.avg_inference_seconds != null ? d.avg_inference_seconds + "s" : t("homeNoSpeedYet"));
      })
      .catch(() => {});
  }

  function renderHomeRecent() {
    const empty = document.getElementById("homeRecentEmpty");
    const body = document.getElementById("homeRecentBody");
    if (!empty || !body) return;

    const hist = getHistory();
    const data = hist[0];
    if (!data) { empty.style.display = "block"; body.style.display = "none"; return; }
    empty.style.display = "none"; body.style.display = "block";

    const info = data.info || {};
    const isAr = currentLang === "ar";
    const isUnrecognized = data.status === "unknown" || data.status === "not_a_plant";
    const conf = isUnrecognized ? (data.unrecognized_confidence ?? 0) : (data.confidence || 0);
    const circumference = 263.9;
    const ringFg = document.getElementById("homeRingFg");
    if (ringFg) { ringFg.style.strokeDashoffset = circumference * (1 - conf / 100); ringFg.classList.toggle("unknown", isUnrecognized); }
    document.getElementById("homeRingText").textContent = conf + "%";
    document.getElementById("homeRecentImg").src = data.image || "";
    document.getElementById("homeRecentName").textContent = data.status === "ok"
      ? ((isAr ? info.arabic_name : info.english_name) || info.english_name || data.prediction)
      : statusLabel(data.status);
    document.getElementById("homeRecentSci").textContent = info.scientific_name || "";

    const badgeRow = document.getElementById("homeRecentBadges");
    badgeRow.innerHTML = "";
    const addBadge = (cls, label) => {
      const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = label;
      badgeRow.appendChild(b);
    };
    if (data.status === "ok") {
      const levelKey = { safe: "toxSafe", low_toxic: "toxLowToxic", dangerous: "toxDangerous", highly_toxic: "toxHighlyToxic", unknown: "toxLevelUnknown" }[info.toxicity_level] || "toxLevelUnknown";
      addBadge("tox-" + (info.toxicity_level || "unknown"), t(levelKey));
      if (info.medicinal) addBadge("medicinal", t("badgeMedicinal"));
    } else {
      addBadge("unknown", statusLabel(data.status));
    }

    const timeEl = document.getElementById("homeRecentTime");
    if (timeEl) {
      timeEl.textContent = data.inference_time_ms
        ? `⏱ ${(data.inference_time_ms / 1000).toFixed(2)}${isAr ? " ثانية" : "s"}`
        : "";
    }

    const top5List = document.getElementById("homeTop5List");
    top5List.innerHTML = "";
    if (data.top3 && data.top3.length) {
      data.top3.forEach((p) => {
        const displayName = (isAr ? p.display_ar : p.display_en) || p.name;
        const row = document.createElement("div");
        row.className = "top3-row";
        row.innerHTML = `<span class="top3-name">${displayName}</span>
          <span class="top3-bar-wrap"><span class="top3-bar" style="width:${p.confidence}%"></span></span>
          <span class="top3-pct">${p.confidence}%</span>`;
        top5List.appendChild(row);
      });
    }

    const gcMini = document.getElementById("homeGradcamMini");
    if (data.gradcam) {
      document.getElementById("homeGcOriginal").src = data.image || "";
      document.getElementById("homeGcHeatmap").src = data.gradcam.overlay;
      gcMini.style.display = "block";
    } else {
      gcMini.style.display = "none";
    }
  }

  on(document.getElementById("homeGoIdentifyBtn"), "click", () => goPage("identify"));
  on(document.getElementById("heroScanBtn"), "click", () => goPage("identify"));

  // The Home page is the default landing page, so load it immediately —
  // not just when the user clicks its nav item. Deferred one tick so it
  // runs after the rest of the script (incl. HIST_KEY below) has set up.
  setTimeout(() => { loadHomeStats(); renderHomeRecent(); }, 0);

  // ---------------------------------------------------------------------
  // Mood Match — light, clearly-labeled exploration feature. Matches are
  // based on this project's own verified 'uses'/'description' text (no
  // invented claims), and only ever surface medicinal, non-dangerous
  // plants — never anything poisonous or classified dangerous/highly_toxic.
  //
  // This is a hand-curated list, not a keyword search — every plant below
  // was picked by actually reading its 'uses' text, not by string-matching
  // (that was producing wrong matches, e.g. Lemon showing up under "calm"
  // just because a word half-matched). If a plant genuinely isn't in our
  // 25 species for a given mood, it's just not listed — no forcing matches.
  // ---------------------------------------------------------------------
  const MOOD_PLANTS = {
    calm: ["khuzama_lavender", "chamomile", "tulsi"],
    anger: ["khuzama_lavender", "chamomile", "tulsi"],
    energy: ["centella", "sage"],
    digestion: ["Mint", "Za'atar", "bohera", "chamomile", "haritoki", "phyllanthus", "rosemary", "sage", "thankuni", "zanjabeel_ginger", "Lemon"],
    immune: ["Justicia", "Lemon", "Za'atar", "tulsi", "phyllanthus"],
    sleep: ["chamomile", "khuzama_lavender"],
  };
  let currentMood = null;

  function moodMatchPlant(p, mood) {
    return (MOOD_PLANTS[mood] || []).includes(p.key);
  }

  function renderMood() {
    const grid = document.getElementById("moodGrid");
    const empty = document.getElementById("moodEmpty");
    if (!grid || !empty) return;

    if (!currentMood) {
      grid.innerHTML = "";
      empty.style.display = "block";
      empty.querySelector("p").textContent = t("moodPickPrompt");
      return;
    }

    const isAr = currentLang === "ar";
    const order = MOOD_PLANTS[currentMood] || [];
    const matches = order
      .map((key) => encPlants.find((p) => p.key === key))
      .filter((p) => p && !p.poisonous && p.toxicity_level !== "dangerous" && p.toxicity_level !== "highly_toxic");

    grid.innerHTML = "";
    if (!matches.length) {
      empty.style.display = "block";
      empty.querySelector("p").textContent = t("moodNoMatch");
      return;
    }
    empty.style.display = "none";

    matches.forEach((p) => {
      const name = (isAr && p.arabic_name) ? p.arabic_name : ((isAr && p.scientific_name) ? p.scientific_name : (p.english_name || p.key));
      const tox = p.toxicity_level || "unknown";
      const card = document.createElement("div");
      card.className = "enc-card tox-" + tox;
      card.innerHTML = `
        ${p.image_url ? `<img class="enc-card-photo" src="${p.image_url}" alt="" loading="lazy">` : `<div class="enc-icon">${ENC_TOX_ICON[tox] || "🌱"}</div>`}
        <div class="enc-name">${name}</div>
        <div class="enc-sci">${p.scientific_name || ""}</div>
        <div class="enc-tox-label">${t(ENC_TOX_KEY[tox] || "toxLevelUnknown")}</div>
      `;
      card.addEventListener("click", () => openMoodRecipe(p));
      grid.appendChild(card);
    });
  }

  // Focused "recipe" card — just the photo, name, and how to prepare it as
  // a drink (reusing the already-verified safe_dosage text, which for the
  // medicinal plants shown here already describes a tea/infusion amount),
  // plus a shortcut into the chatbot for follow-up questions.
  function openMoodRecipe(p) {
    encCurrentPlant = p;
    const isAr = currentLang === "ar";
    const photoEl = document.getElementById("moodModalPhoto");
    if (p.image_url) {
      photoEl.innerHTML = `<img src="${p.image_url}" alt="">`;
    } else {
      photoEl.innerHTML = `<div class="mood-modal-icon">${plantIcon(p)}</div>`;
    }
    document.getElementById("moodModalName").textContent = plantDisplayName(p, isAr);
    document.getElementById("moodModalSci").textContent = p.scientific_name || "";

    const recipeBlock = document.getElementById("moodRecipeBlock");
    const noRecipeText = document.getElementById("moodNoRecipeText");
    const recipe = (p.recipes && p.recipes[0]) || null;

    if (recipe) {
      recipeBlock.style.display = "block";
      noRecipeText.style.display = "none";
      document.getElementById("moodRecipeTitle").textContent = "🍵 " + ((isAr && recipe.title_ar) ? recipe.title_ar : recipe.title);

      const ingredients = (isAr && recipe.ingredients_ar) ? recipe.ingredients_ar : recipe.ingredients;
      document.getElementById("moodIngredientsList").innerHTML = (ingredients || []).map((i) => `<li>${i}</li>`).join("");

      const steps = (isAr && recipe.steps_ar) ? recipe.steps_ar : recipe.steps;
      document.getElementById("moodStepsList").innerHTML = (steps || []).map((s) => `<li>${s}</li>`).join("");

      const benefits = (isAr && recipe.benefits_ar) ? recipe.benefits_ar : recipe.benefits;
      const benefitsBlock = document.getElementById("moodBenefitsBlock");
      if (benefits && benefits.length) {
        benefitsBlock.style.display = "block";
        document.getElementById("moodBenefitsList").innerHTML = benefits.map((b) => `<li>${b}</li>`).join("");
      } else {
        benefitsBlock.style.display = "none";
      }
    } else {
      recipeBlock.style.display = "none";
      noRecipeText.style.display = "block";
      noRecipeText.textContent = t("moodNoPrep");
    }

    const moodOverlay = document.getElementById("moodOverlay");
    moodOverlay.classList.add("show");
    moodOverlay.setAttribute("aria-hidden", "false");
  }

  function closeMoodRecipe() {
    const moodOverlay = document.getElementById("moodOverlay");
    moodOverlay.classList.remove("show");
    moodOverlay.setAttribute("aria-hidden", "true");
  }
  on(document.getElementById("moodCloseBtn"), "click", closeMoodRecipe);
  on(document.getElementById("moodOverlay"), "click", (e) => {
    if (e.target.id === "moodOverlay") closeMoodRecipe();
  });
  on(document.getElementById("moodAskBtn"), "click", () => {
    if (!encCurrentPlant) return;
    lastPredictedClass = encCurrentPlant.key;
    closeMoodRecipe();
    goPage("chatbot");
    if (!chatStarted) startChat();
  });

  document.querySelectorAll(".mood-btn").forEach((btn) => {
    on(btn, "click", () => {
      currentMood = btn.getAttribute("data-mood");
      document.querySelectorAll(".mood-btn").forEach((b) => b.classList.toggle("on", b === btn));
      renderMood();
    });
  });

  // ---------------------------------------------------------------------
  // Upload + Analyze (Identify page)
  // ---------------------------------------------------------------------
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const cameraInput = document.getElementById("cameraInput");
  const preview = document.getElementById("preview");
  const uploadBtn = document.getElementById("uploadBtn");
  const cameraBtn = document.getElementById("cameraBtn");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const errorBox = document.getElementById("errorBox");

  let selectedFile = null;
  let lastPredictedClass = null; // used as chatbot context

  uploadBtn.addEventListener("click", () => fileInput.click());
  cameraBtn.addEventListener("click", () => cameraInput.click());
  const dzCamFab = document.getElementById("dzCamFab");
  if (dzCamFab) dzCamFab.addEventListener("click", (e) => { e.stopPropagation(); cameraInput.click(); });
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter") fileInput.click(); });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); dropzone.classList.remove("over");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });
  cameraInput.addEventListener("change", () => { if (cameraInput.files.length) handleFile(cameraInput.files[0]); });

  // Hero upload area (Home page) — same real handleFile()/goPage(), just a second entry point
  const heroUpload = document.getElementById("heroUpload");
  if (heroUpload) {
    heroUpload.addEventListener("click", () => { goPage("identify"); fileInput.click(); });
    heroUpload.addEventListener("keydown", (e) => { if (e.key === "Enter") { goPage("identify"); fileInput.click(); } });
    heroUpload.addEventListener("dragover", (e) => { e.preventDefault(); heroUpload.classList.add("over"); });
    heroUpload.addEventListener("dragleave", () => heroUpload.classList.remove("over"));
    heroUpload.addEventListener("drop", (e) => {
      e.preventDefault(); heroUpload.classList.remove("over");
      if (e.dataTransfer.files.length) { goPage("identify"); handleFile(e.dataTransfer.files[0]); }
    });
  }
  // Hero search box — same behaviour as the Plants-page search, just launched from Home
  const heroSearchInput = document.getElementById("heroSearchInput");
  if (heroSearchInput) {
    const goSearch = () => {
      const q = heroSearchInput.value.trim();
      goPage("encyclopedia");
      const encSearch = document.getElementById("encSearch");
      if (encSearch) { encSearch.value = q; encSearch.dispatchEvent(new Event("input")); }
    };
    heroSearchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goSearch(); });
    const heroSearchBtn = document.getElementById("heroSearchBtn");
    if (heroSearchBtn) heroSearchBtn.addEventListener("click", goSearch);
  }

  function handleFile(file) {
    hideError();
    selectedFile = file;
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    analyzeBtn.disabled = false;
    resetResultPanels();
  }

  function showError(msg) { errorBox.textContent = msg; errorBox.style.display = "block"; showToast(msg, true); }
  function hideError() { errorBox.style.display = "none"; }

  function resetResultPanels() {
    lastRenderedResult = null;
    document.getElementById("resultEmpty").style.display = "block";
    document.getElementById("resultBody").style.display = "none";
    document.getElementById("resultBody").classList.remove("fade-in");
    document.getElementById("top3Card").style.display = "none";
    document.getElementById("gradcamCard").style.display = "none";
    document.getElementById("infoCard").style.display = "none";
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        const maxDim = 640;
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  analyzeBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    hideError();
    resetResultPanels();
    analyzeBtn.disabled = true;
    openScanOverlay(preview.src);

    const formData = new FormData();
    formData.append("image", selectedFile);

    try {
      const [res, imgDataUrl] = await Promise.all([
        fetch("/predict", { method: "POST", body: formData }),
        fileToDataURL(selectedFile),
      ]);
      const data = await res.json();
      analyzeBtn.disabled = false;

      if (data.error) {
        abortScanOverlay();
        showError(data.error);
        return;
      }

      data.image = imgDataUrl;
      data.timestamp = Date.now();
      if (data.status === "ok") lastPredictedClass = data.prediction;
      saveToHistory(data);

      closeScanOverlay(() => {
        renderResult(data);
        document.getElementById("resultBody").classList.add("fade-in");
        showToast(t("analysisComplete"));
      });
    } catch (e) {
      analyzeBtn.disabled = false;
      abortScanOverlay();
      showError(t("errNoServer"));
    }
  });


  let lastRenderedResult = null;
  function renderResult(data) {
    lastRenderedResult = data;
    const info = data.info || {};

    document.getElementById("resultEmpty").style.display = "none";
    document.getElementById("resultBody").style.display = "flex";

    const isUnrecognized = data.status === "unknown" || data.status === "not_a_plant";
    const conf = isUnrecognized ? (data.unrecognized_confidence ?? 0) : (data.confidence || 0);
    const circumference = 263.9;
    const ringFg = document.getElementById("ringFg");
    ringFg.style.strokeDashoffset = circumference * (1 - conf / 100);
    ringFg.classList.toggle("unknown", isUnrecognized);
    document.getElementById("ringText").textContent = conf + "%";
    const ringCaption = document.getElementById("ringCaption");
    if (ringCaption) {
      if (data.status === "not_a_plant") {
        ringCaption.textContent = t("ringNotAPlantCaption");
      } else if (isUnrecognized) {
        ringCaption.textContent = t("ringUnknownCaption");
      } else if (data.status === "ok") {
        // Text confidence-status label alongside the percentage, in addition
        // to the numeric ring — a percentage alone doesn't tell most users
        // whether 62% is "good enough" or not.
        ringCaption.textContent = conf >= 85 ? t("ringHighConf") : t("ringMediumConf");
      } else {
        ringCaption.textContent = "";
      }
      ringCaption.style.display = ringCaption.textContent ? "block" : "none";
    }

    document.getElementById("resultName").textContent = data.status === "ok" ? ((currentLang === "ar" ? (info.arabic_name || info.scientific_name) : info.english_name) || info.english_name || data.prediction) : statusLabel(data.status);
    document.getElementById("resultSci").textContent = info.scientific_name || "";

    const badgeRow = document.getElementById("badgeRow");
    badgeRow.innerHTML = "";
    const addBadge = (cls, label) => {
      const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = label;
      badgeRow.appendChild(b);
    };
    if (data.status === "ok") {
      const levelKey = { safe: "toxSafe", low_toxic: "toxLowToxic", dangerous: "toxDangerous", highly_toxic: "toxHighlyToxic", unknown: "toxLevelUnknown" }[info.toxicity_level] || "toxLevelUnknown";
      addBadge("tox-" + (info.toxicity_level || "unknown"), t(levelKey));
      if (info.medicinal) addBadge("medicinal", t("badgeMedicinal"));
    } else {
      addBadge("unknown", statusLabel(data.status));
    }

    // A quiet, refined "success" moment (Apple-style, not confetti) -- a
    // brief glow pulse around the result card when we're confidently
    // right, nothing on low-confidence/unmatched results.
    if (data.status === "ok" && conf >= 70) {
      const resultBody = document.getElementById("resultBody");
      resultBody.classList.remove("result-celebrate");
      void resultBody.offsetWidth;
      resultBody.classList.add("result-celebrate");
    }

    document.getElementById("attrFamily").textContent = (currentLang === "ar" && info.family_ar) ? info.family_ar : (info.family || "—");
    document.getElementById("attrToxicity").textContent = data.status === "ok"
      ? t({ safe: "toxSafe", low_toxic: "toxLowToxic", dangerous: "toxDangerous", highly_toxic: "toxHighlyToxic", unknown: "toxLevelUnknown" }[info.toxicity_level] || "toxLevelUnknown")
      : t("toxUnk");
    document.getElementById("attrHabitat").textContent = (currentLang === "ar" && info.habitat_ar) ? info.habitat_ar : (info.habitat || "—");
    document.getElementById("attrStatus").textContent = statusLabel(data.status);

    const msgBanner = document.getElementById("resultMessage");
    const statusMsgKey = { not_a_plant: "msgNotAPlant", unknown: "msgUnknown", low_confidence: "msgLowConf" }[data.status];
    if (statusMsgKey) {
      msgBanner.textContent = t(statusMsgKey);
      msgBanner.className = "msg-banner show " + (data.status === "low_confidence" ? "warn" : "danger");
    } else {
      msgBanner.className = "msg-banner";
    }

    const top3List = document.getElementById("top3List");
    top3List.innerHTML = "";
    if (data.top3 && data.top3.length) {
      data.top3.forEach((p) => {
        const displayName = (currentLang === "ar" ? p.display_ar : p.display_en) || p.name;
        const row = document.createElement("div");
        row.className = "top3-row";
        row.innerHTML = `<span class="top3-name">${displayName}</span>
          <span class="top3-bar-wrap"><span class="top3-bar" style="width:${p.confidence}%"></span></span>
          <span class="top3-pct">${p.confidence}%</span>`;
        top3List.appendChild(row);
      });
      document.getElementById("top3Card").style.display = "block";
    }

    if (data.gradcam) {
      document.getElementById("gcOriginal").src = data.image;
      document.getElementById("gcHeatmap").src = data.gradcam.overlay;
      document.getElementById("gradcamCard").style.display = "block";
    }

    let anyInfo = false;
    const descEl = document.getElementById("infoDesc");
    const descText = (currentLang === "ar" && info.description_ar) ? info.description_ar : info.description;
    if (descText) { descEl.textContent = descText; descEl.style.display = "block"; anyInfo = true; } else descEl.style.display = "none";

    const rowUses = document.getElementById("rowUses");
    const usesArr = (currentLang === "ar" && info.uses_ar && info.uses_ar.length) ? info.uses_ar : info.uses;
    if (usesArr && usesArr.length) {
      document.getElementById("infoUses").textContent = usesArr.join(" · ");
      rowUses.style.display = "block"; anyInfo = true;
    } else rowUses.style.display = "none";

    const tagsEl = document.getElementById("infoTags");
    tagsEl.innerHTML = "";
    (info.active_compounds || []).forEach((c) => {
      const s = document.createElement("span"); s.className = "tag"; s.textContent = c; tagsEl.appendChild(s);
    });
    if (info.active_compounds && info.active_compounds.length) anyInfo = true;

    const rowWarn = document.getElementById("rowWarn");
    const warnText = (currentLang === "ar" && info.warnings_ar) ? info.warnings_ar : info.warnings;
    if (warnText) { document.getElementById("infoWarn").textContent = warnText; rowWarn.style.display = "block"; anyInfo = true; } else rowWarn.style.display = "none";

    const rowGrowing = document.getElementById("rowGrowing");
    const growingText = (currentLang === "ar" && info.growing_method_ar) ? info.growing_method_ar : info.growing_method;
    if (growingText) { document.getElementById("infoGrowing").textContent = growingText; rowGrowing.style.display = "block"; anyInfo = true; } else rowGrowing.style.display = "none";

    const rowCare = document.getElementById("rowCare");
    const careText = (currentLang === "ar" && info.care_ar) ? info.care_ar : info.care;
    if (careText) { document.getElementById("infoCare").textContent = careText; rowCare.style.display = "block"; anyInfo = true; } else rowCare.style.display = "none";

    const rowPests = document.getElementById("rowPests");
    const pestsArr = (currentLang === "ar" && info.common_pests_ar && info.common_pests_ar.length) ? info.common_pests_ar : info.common_pests;
    if (pestsArr && pestsArr.length) {
      document.getElementById("infoPests").textContent = pestsArr.join(" · ");
      rowPests.style.display = "block"; anyInfo = true;
    } else rowPests.style.display = "none";

    const rowDistribution = document.getElementById("rowDistribution");
    const distText = (currentLang === "ar" && info.geographic_distribution_ar) ? info.geographic_distribution_ar : info.geographic_distribution;
    if (distText) { document.getElementById("infoDistribution").textContent = distText; rowDistribution.style.display = "block"; anyInfo = true; } else rowDistribution.style.display = "none";

    const rowDosage = document.getElementById("rowDosage");
    const dosageText = (currentLang === "ar" && info.safe_dosage_ar) ? info.safe_dosage_ar : info.safe_dosage;
    if (dosageText) { document.getElementById("infoDosage").textContent = dosageText; rowDosage.style.display = "block"; anyInfo = true; } else rowDosage.style.display = "none";

    document.getElementById("infoCard").style.display = anyInfo ? "block" : "none";
  }

  // ---------------------------------------------------------------------
  // History (localStorage, this device only)
  // ---------------------------------------------------------------------
  const HIST_KEY = "plantai_history";
  const MAX_HIST = 20;

  function saveToHistory(entry) {
    let hist = [];
    try { hist = JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (e) {}
    hist.unshift(entry);
    if (hist.length > MAX_HIST) hist = hist.slice(0, MAX_HIST);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); }
    catch (e) { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, 5))); }
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (e) { return []; }
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  function renderHistory() {
    const list = document.getElementById("historyList");
    const empty = document.getElementById("historyEmpty");
    const clearBtn = document.getElementById("clearHistoryBtn");
    const hist = getHistory();
    list.innerHTML = "";

    if (!hist.length) { empty.style.display = "block"; clearBtn.style.display = "none"; return; }
    empty.style.display = "none"; clearBtn.style.display = "inline-flex";

    hist.forEach((data) => {
      const info = data.info || {};
      const name = data.status === "ok" ? ((currentLang === "ar" ? (info.arabic_name || info.scientific_name) : info.english_name) || info.english_name || data.prediction) : statusLabel(data.status);
      const shownConf = (data.status === "unknown" || data.status === "not_a_plant") ? (data.unrecognized_confidence ?? data.confidence) : data.confidence;
      let dotCls = "warn";
      if (data.status === "ok") {
        dotCls = { safe: "safe", low_toxic: "warn", dangerous: "warn", highly_toxic: "danger", unknown: "warn" }[info.toxicity_level] || "warn";
      }
      const row = document.createElement("div");
      row.className = "hist-row";
      row.innerHTML = `<img class="hist-thumb" src="${data.image || ""}">
        <div><div class="hist-name">${name}</div><div class="hist-meta">${shownConf}% · ${timeAgo(data.timestamp)}</div></div>
        <span class="hist-dot ${dotCls}"></span>`;
      row.addEventListener("click", () => {
        goPage("identify");
        renderResult(data);
        document.getElementById("preview").src = data.image;
        document.getElementById("preview").style.display = "block";
      });
      list.appendChild(row);
    });
  }
  on(document.getElementById("clearHistoryBtn"), "click", () => {
    localStorage.removeItem(HIST_KEY);
    renderHistory();
  });

  on(document.getElementById("resetAllBtn"), "click", () => {
    if (!confirm(t("resetAllConfirm"))) return;
    localStorage.removeItem(HIST_KEY);
    localStorage.removeItem(FAV_KEY);
    renderHistory();
    renderHomeRecent();
    if (encLoaded) { renderEncGrid(); renderHerbarium(); }
    showToast(t("resetAllDone"));
  });

  // ---------------------------------------------------------------------
  // Chatbot — renders structured JSON from /chat (not plain text) as rich
  // cards: plant profile card, mood-suggestion chips, or a "not found"
  // fallback with example prompts. See app.py's chatbot_reply().
  // ---------------------------------------------------------------------
  let chatStarted = false;
  let chatCardCounter = 0;
  const chatWindow = document.getElementById("chatWindow");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");

  const QUICK_EXAMPLES = {
    en: { "uses-example": "uses of mint", "recipe-example": "how to prepare ginger tea", "warn-example": "warnings for oleander", "grow-example": "how is rosemary grown" },
    ar: { "uses-example": "فوائد النعناع", "recipe-example": "طريقة تحضير شاي الزنجبيل", "warn-example": "تحذيرات الدفلة", "grow-example": "كيف يزرع إكليل الجبل" },
  };
  const CHAT_TOX_KEY = { safe: "toxSafe", low_toxic: "toxLowToxic", dangerous: "toxDangerous", highly_toxic: "toxHighlyToxic", unknown: "toxLevelUnknown" };

  function scrollChatToBottom() {
    // Read/write scrollTop after two animation frames, not immediately:
    // right after appendChild/innerHTML the browser hasn't necessarily
    // finished layout yet (this is especially true the very first time a
    // bubble renders, before the Google Fonts swap from the fallback
    // font finishes and can quietly change text height afterward). Two
    // rAFs reliably land after the next paint, so scrollHeight reflects
    // the real, final size instead of a smaller mid-layout snapshot.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chatWindow.scrollTop = chatWindow.scrollHeight;
      });
    });
  }

  // Safety net for the font-swap case: once the custom webfonts finish
  // loading (they load async and can resize already-rendered text), do
  // one more scroll-to-bottom pass so the first message of the session
  // doesn't get left stranded mid-scroll.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scrollChatToBottom);
  }

  // Bring a just-added bubble to the TOP of the visible chat window
  // instead of jumping to the absolute bottom of the scroll area. A long
  // answer can be taller than the whole window, so "scroll to bottom"
  // used to land past the user's own question (and past the start of
  // the reply) -- anchoring the new bubble's top to the window's top
  // means you always see your question (or the start of the answer)
  // right away, then scroll down within the window to read the rest.
  function scrollBubbleIntoView(el) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function addPlainBubble(text, who) {
    const b = document.createElement("div");
    b.className = "bubble " + who;
    b.textContent = text;
    chatWindow.appendChild(b);
    scrollBubbleIntoView(b);
    return b;
  }

  function addRichBubble(html) {
    const b = document.createElement("div");
    b.className = "bubble bot rich";
    b.innerHTML = html;
    chatWindow.appendChild(b);
    scrollBubbleIntoView(b);
    // Images load asynchronously and can push content down after the
    // initial scroll -- re-anchor once each image finishes loading too.
    b.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", () => scrollBubbleIntoView(b));
    });
    return b;
  }

  function chatQuickChipsHtml() {
    return `<div class="chat-quick-row">
      <button class="chat-quick-chip" data-q="uses-example">${t("chatQuickUses")}</button>
      <button class="chat-quick-chip" data-q="recipe-example">${t("chatQuickRecipes")}</button>
      <button class="chat-quick-chip" data-q="warn-example">${t("chatQuickWarnings")}</button>
      <button class="chat-quick-chip" data-q="grow-example">${t("chatQuickGrowing")}</button>
    </div>`;
  }

  function esc(s) { return (s || "").replace(/"/g, "&quot;"); }

  // Single source of truth for the 4 possible /predict statuses, so every
  // place that shows a status label (ring name, badge, attr row, history
  // list) stays consistent when a new one (not_a_plant) gets added.
  function statusLabel(status) {
    if (status === "ok") return t("statusOk");
    if (status === "low_confidence") return t("statusLow");
    if (status === "not_a_plant") return t("statusNotAPlant");
    return t("statusUnknown");
  }

  function suggestionChipsHtml(p) {
    const isAr = currentLang === "ar";
    const name = p.name;
    const items = isAr
      ? [`🍵 كيف أحضر مشروب ${name}؟`, `⚠ هل لـ${name} آثار جانبية؟`, `🌱 كيف يُزرع ${name}؟`]
      : [`🍵 How do I prepare ${name}?`, `⚠ Does ${name} have side effects?`, `🌱 How is ${name} grown?`];
    return `<div class="chat-quick-row">` + items.map((s) => `<button class="chat-quick-chip" data-send="${esc(s)}">${s}</button>`).join("") + `</div>`;
  }

  function storyIntroHtml(story) {
    return story ? `<div class="chat-story-intro">${story}</div>` : "";
  }

  function plantCardHtml(p) {
    chatCardCounter++;
    const prepId = `chatPrep${chatCardCounter}`;
    const toxKey = CHAT_TOX_KEY[p.toxicity_level] || "toxLevelUnknown";

    let html = storyIntroHtml(p.story_intro);
    html += `<div class="chat-plant-card">`;
    html += `<div class="chat-plant-head">`;
    html += p.image_url ? `<img class="chat-plant-img" src="${p.image_url}" alt="">` : `<div class="chat-plant-icon">${ENC_TOX_ICON[p.toxicity_level] || "🌱"}</div>`;
    html += `<div><div class="chat-plant-name">${p.name}</div>${p.scientific_name ? `<div class="chat-plant-sci">${p.scientific_name}</div>` : ""}</div>`;
    html += `</div>`;

    html += `<div class="chat-plant-badges">`;
    html += `<span class="badge tox-${p.toxicity_level}">${t(toxKey)}</span>`;
    if (p.medicinal) html += `<span class="badge medicinal">${t("badgeMedicinal")}</span>`;
    html += `</div>`;

    if (p.description) {
      html += `<div class="chat-section"><span class="chat-section-label">${t("chatSectionDesc")}</span>${p.description}</div>`;
    }

    html += `<div class="chat-section"><span class="chat-section-label">${t("chatSectionUses")}</span>`;
    html += (p.uses && p.uses.length)
      ? `<ul class="chat-uses-list">` + p.uses.map((u) => `<li>${u}</li>`).join("") + `</ul>`
      : t("chatNoUses");
    html += `</div>`;

    html += `<div class="chat-section"><span class="chat-section-label">${t("chatSectionRecipe")}</span></div>`;
    html += `<button class="chat-prep-btn" data-prep-toggle="${prepId}">${t("chatShowPrep")}</button>`;
    html += `<div class="chat-prep-box" id="${prepId}">${p.prep || t("chatNoPrep")}</div>`;

    if (p.warnings) {
      html += `<div class="chat-section warn"><span class="chat-section-label">${t("chatSectionWarn")}</span>${p.warnings}</div>`;
    }
    if (p.growing_method) {
      html += `<div class="chat-section"><span class="chat-section-label">${t("chatSectionGrow")}</span>${p.growing_method}</div>`;
    }
    if (p.source_url) {
      html += `<a class="chat-source-btn" href="${p.source_url}" target="_blank" rel="noopener">${t("chatSectionSource")}: Wikipedia</a>`;
    }

    html += `<span class="chat-section-label">${t("chatRelatedTitle")}</span>`;
    html += suggestionChipsHtml(p);
    html += `</div>`;
    return html;
  }

  function relatedActionsHtml(actions) {
    if (!actions || !actions.length) return "";
    return `<div class="chat-quick-row">` + actions.map((a) => `<button class="chat-quick-chip" data-send="${esc(a.query)}">${a.label}</button>`).join("") + `</div>`;
  }

  // Focused answer: user asked about ONE specific thing (e.g. "فوائد
  // النعناع") -> show ONLY that part, plus small follow-up buttons to
  // expand into a related field without retyping (product decision
  // 2026-07-26). A story intro only ever appears on the general/full
  // card path, so data.story_intro is normally null here.
  function focusedAnswerHtml(data) {
    let html = storyIntroHtml(data.story_intro);
    const sectionClass = data.field === "warnings" ? "chat-section warn" : "chat-section";

    html += `<div class="chat-focused-answer">`;
    html += `<div class="chat-plant-name">${data.name}</div>`;

    if (data.content_type === "recipe") {
      const r = data.content;
      if (!r) {
        html += `<div class="chat-section"><span class="chat-section-label">${data.field_label}</span>${t("chatNoRecipe")}</div>`;
      } else {
        if (r.title) html += `<div class="chat-section"><span class="chat-section-label">${data.field_label}</span>${r.title}</div>`;
        if (r.ingredients && r.ingredients.length) {
          html += `<div class="chat-section"><span class="chat-section-label">${t("chatRecipeIngredients")}</span>`;
          html += `<ul class="chat-uses-list">` + r.ingredients.map((i) => `<li>${i}</li>`).join("") + `</ul></div>`;
        }
        if (r.steps && r.steps.length) {
          html += `<div class="chat-section"><span class="chat-section-label">${t("chatRecipeSteps")}</span>`;
          html += `<ol class="chat-steps-list">` + r.steps.map((s) => `<li>${s}</li>`).join("") + `</ol></div>`;
        }
        if (r.tip) html += `<div class="chat-section"><span class="chat-section-label">${t("chatRecipeTip")}</span>${r.tip}</div>`;
      }
    } else if (data.content_type === "growing") {
      const g = data.content;
      if (!g || (!g.method && !g.care)) {
        html += `<div class="chat-section"><span class="chat-section-label">${data.field_label}</span>${t("chatNoFieldData")}</div>`;
      } else {
        if (g.method) html += `<div class="chat-section"><span class="chat-section-label">${data.field_label}</span>${g.method}</div>`;
        if (g.care) html += `<div class="chat-section"><span class="chat-section-label">${t("chatCareLabel")}</span>${g.care}</div>`;
      }
    } else if (data.content_type === "list") {
      html += `<div class="${sectionClass}"><span class="chat-section-label">${data.field_label}</span>`;
      html += (data.content && data.content.length)
        ? `<ul class="chat-uses-list">` + data.content.map((c) => `<li>${c}</li>`).join("") + `</ul>`
        : (data.field === "uses" ? t("chatNoUses") : t("chatNoFieldData"));
      html += `</div>`;
    } else {
      const text = (data.content || "").trim();
      html += `<div class="${sectionClass}"><span class="chat-section-label">${data.field_label}</span>`;
      html += text || (data.field === "warnings" ? t("chatNoWarn") : t("chatNoFieldData"));
      html += `</div>`;
    }

    html += relatedActionsHtml(data.related_actions);
    html += `</div>`;
    return html;
  }

  function moodCardHtml(data) {
    let html = `<div>${t("chatMoodIntro")}</div><div class="chat-mood-row">`;
    (data.plants || []).forEach((p) => {
      html += `<button class="chat-mood-chip" data-send="${esc(p.name)}">${ENC_TOX_ICON[p.toxicity_level] || "🌱"} ${p.name}</button>`;
    });
    html += `</div><p class="info-text" style="margin-top:6px">${t("chatMoodPick")}</p>`;
    return html;
  }

  function notFoundHtml() {
    return `<div>${t("chatNotFoundTitle")}</div><p class="info-text" style="margin:4px 0">${t("chatNotFoundHint")}</p>${chatQuickChipsHtml()}`;
  }

  function renderChatResponse(data) {
    if (data.type === "plant") {
      addRichBubble(plantCardHtml(data));
      if (data.plant_key) lastPredictedClass = data.plant_key;
    } else if (data.type === "plant_focused") {
      addRichBubble(focusedAnswerHtml(data));
      if (data.plant_key) lastPredictedClass = data.plant_key;
    } else if (data.type === "mood") {
      addRichBubble(moodCardHtml(data));
    } else if (data.type === "not_found") {
      addRichBubble(notFoundHtml());
    } else if (data.type === "forbidden") {
      addPlainBubble(t("chatForbiddenMsg"), "bot");
    } else {
      addRichBubble(`<div>${t("chatWelcome")}</div>${chatQuickChipsHtml()}`);
    }
  }

  function startChat() {
    chatStarted = true;
    addRichBubble(`<div>${t("chatWelcome")}</div>${chatQuickChipsHtml()}`);
  }

  function showTypingIndicator() {
    const b = document.createElement("div");
    b.className = "bubble bot typing";
    b.id = "chatTypingIndicator";
    b.innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
    chatWindow.appendChild(b);
    scrollBubbleIntoView(b);
  }
  function removeTypingIndicator() {
    const b = document.getElementById("chatTypingIndicator");
    if (b) b.remove();
  }

  async function sendChat(overrideMsg) {
    const msg = (overrideMsg !== undefined ? overrideMsg : chatInput.value).trim();
    if (!msg) return;
    addPlainBubble(msg, "user");
    chatInput.value = "";
    chatSendBtn.disabled = true;
    showTypingIndicator();
    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, current_plant: lastPredictedClass }),
      });
      const data = await res.json();
      removeTypingIndicator();
      renderChatResponse(data);
    } catch (e) {
      removeTypingIndicator();
      addPlainBubble(t("errNoServer"), "bot");
    }
    chatSendBtn.disabled = false;
  }
  chatSendBtn.addEventListener("click", () => sendChat());
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  // One delegated listener for everything clickable inside chat bubbles:
  // quick-action chips send an example query, suggestion/mood chips send
  // their own label text, and the prep-method button toggles its box.
  chatWindow.addEventListener("click", (e) => {
    const quick = e.target.closest(".chat-quick-chip[data-q]");
    if (quick) {
      const examples = QUICK_EXAMPLES[currentLang] || QUICK_EXAMPLES.en;
      sendChat(examples[quick.getAttribute("data-q")]);
      return;
    }
    const sendable = e.target.closest("[data-send]");
    if (sendable) {
      sendChat(sendable.getAttribute("data-send"));
      return;
    }
    const prepToggle = e.target.closest("[data-prep-toggle]");
    if (prepToggle) {
      const box = document.getElementById(prepToggle.getAttribute("data-prep-toggle"));
      if (box) {
        const showing = box.classList.toggle("show");
        prepToggle.textContent = showing ? t("chatHidePrep") : t("chatShowPrep");
      }
    }
  });

})();