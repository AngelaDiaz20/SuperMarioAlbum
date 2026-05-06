/* Super Mario Sticker Checklist (Shared)
   - HTML + CSS + JavaScript vanilla
   - Persistencia remota: Supabase (sin login)
   - Fuente de verdad: Supabase
   - LocalStorage: solo caché (mejor UX)
*/

(() => {
  "use strict";

  // ============================================================================
  //  CONFIGURACIÓN (edita antes de deploy)
  // ============================================================================
  // SUPABASE_URL y SUPABASE_ANON_KEY son valores públicos en apps frontend.
  // NUNCA uses la service_role key en el frontend.
  //
  // COLLECTION_ACCESS_CODE queda "quemado" para que la app cargue automáticamente
  // la misma colección compartida, sin login ni pantalla para ingresar código.
  // Si necesitas seguridad real: implementa Supabase Auth o una función serverless.
  const SUPABASE_URL = "https://ydcgppqaftxnioeeduhj.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkY2dwcHFhZnR4bmlvZWVkdWhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MDA1OTEsImV4cCI6MjA5Mjk3NjU5MX0.HhxrSn9Ke8wPfyiwgCWGHaK99AgiLWwFKwK-uzcXm3E";
  const COLLECTION_ACCESS_CODE = "MARIO-FAMILIA-8392";

  const ENABLE_EXTENDED_COLLECTION = false;

  const ALBUM_CONFIG = {
    name: "Super Mario Sticker Checklist",
    officialSections: [
      { id: "main", label: "Álbum principal", prefix: "", from: 1, to: 180, pad: 3 },
      { id: "poster", label: "Póster / M", prefix: "M", from: 1, to: 44, pad: 0 },
    ],
    extendedSections: [
      { id: "limited", label: "Limited Edition", prefix: "LE", from: 1, to: 8, pad: 0 },
      { id: "optichrome", label: "Optichrome", prefix: "O", from: 1, to: 16, pad: 0 },
    ],
  };

  // Debounce para no escribir demasiado en Supabase
  const SAVE_DEBOUNCE_MS = 650;
  const POLL_INTERVAL_MS = 10_000;
  const SUPABASE_LOAD_TIMEOUT_MS = 10_000;

  // Caché local (UX). No es fuente de verdad.
  const CACHE_KEY = "sm_supabase_cache_v1";
  const UI_PREFS_KEY = "sm_ui_prefs_v1";
  const CLIENT_ID_KEY = "sm_client_id_v1";

  // ============================================================================
  //  DOM
  // ============================================================================

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    toastRegion: $("#toastRegion"),

    metricHave: $("#metricHave"),
    metricMissing: $("#metricMissing"),
    metricDupes: $("#metricDupes"),
    summaryLine: $("#summaryLine"),
    progressText: $("#progressText"),
    progressBar: $("#progressBar"),
    progressRail: $(".progress-rail"),

    syncStatusPill: $("#syncStatusPill"),

    tabs: $$(".tab[data-filter]"),
    orderBtn: $("#orderBtn"),

    searchInput: $("#searchInput"),
    searchBtn: $("#searchBtn"),
    clearSearchBtn: $("#clearSearchBtn"),

    importFile: $("#importFile"),

    albumView: $("#albumView"),
    statsView: $("#statsView"),
    syncView: $("#syncView"),
    settingsView: $("#settingsView"),
    bottomNav: $(".bottom-nav"),

    stickerModal: $("#stickerModal"),
    modalStickerId: $("#modalStickerId"),
    modalStickerSection: $("#modalStickerSection"),
    modalOwned: $("#modalOwned"),
    modalDupes: $("#modalDupes"),
  };

  // ============================================================================
  //  Helpers
  // ============================================================================

  function padNumber(n, width) {
    if (!width || width <= 0) return String(n);
    return String(n).padStart(width, "0");
  }

  function safeParseJSON(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return ch;
      }
    });
  }

  function withTimeout(promise, ms, label = "timeout") {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(label)), ms);
      Promise.resolve(promise)
        .then((v) => {
          clearTimeout(t);
          resolve(v);
        })
        .catch((err) => {
          clearTimeout(t);
          reject(err);
        });
    });
  }

  function getOrCreateClientId() {
    try {
      const existing = localStorage.getItem(CLIENT_ID_KEY);
      if (existing && typeof existing === "string" && existing.length > 10) return existing;
      const id = `client_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
      localStorage.setItem(CLIENT_ID_KEY, id);
      return id;
    } catch {
      return `client_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
    }
  }

  const clientId = getOrCreateClientId();

  function setSyncStatus(kind, text) {
    if (!els.syncStatusPill) return;
    els.syncStatusPill.classList.remove("is-loading", "is-saving", "is-saved", "is-error", "is-offline");
    if (kind) els.syncStatusPill.classList.add(`is-${kind}`);
    els.syncStatusPill.textContent = text;
  }

  // ============================================================================
  //  Album items
  // ============================================================================

  function buildItems() {
    const sections = [...ALBUM_CONFIG.officialSections];
    if (ENABLE_EXTENDED_COLLECTION) sections.push(...ALBUM_CONFIG.extendedSections);

    const items = [];
    for (const s of sections) {
      for (let i = s.from; i <= s.to; i++) {
        const id = `${s.prefix}${padNumber(i, s.pad)}`;
        items.push({
          id,
          sectionId: s.id,
          sectionLabel: s.label,
          order: items.length,
        });
      }
    }
    return items;
  }

  console.log("Generating stickers...");
  const ITEMS = buildItems();
  const IDS = new Set(ITEMS.map((x) => x.id));

  function canonicalizeStickerId(rawId) {
    const raw = String(rawId || "").trim().toUpperCase();
    if (!raw) return null;

    // M01 -> M1
    let m = raw.match(/^M\s*0*([0-9]{1,2})$/);
    if (m) return `M${Number(m[1])}`;

    // LE03 -> LE3
    m = raw.match(/^LE\s*0*([0-9]{1,2})$/);
    if (m) return `LE${Number(m[1])}`;

    // O02 -> O2
    m = raw.match(/^O\s*0*([0-9]{1,2})$/);
    if (m) return `O${Number(m[1])}`;

    // 45 -> 045
    m = raw.match(/^0*([0-9]{1,3})$/);
    if (m) return padNumber(Number(m[1]), 3);

    return raw;
  }

  function normalizeSearchId(input) {
    const id = canonicalizeStickerId(input);
    if (!id) return null;

    // Limita a los rangos conocidos (básico)
    if (id.startsWith("M")) {
      const n = Number(id.slice(1));
      if (!Number.isFinite(n) || n < 1 || n > 99) return null;
      return `M${n}`;
    }
    if (id.startsWith("LE")) {
      const n = Number(id.slice(2));
      if (!Number.isFinite(n) || n < 1 || n > 99) return null;
      return `LE${n}`;
    }
    if (id.startsWith("O")) {
      const n = Number(id.slice(1));
      if (!Number.isFinite(n) || n < 1 || n > 99) return null;
      return `O${n}`;
    }
    if (/^[0-9]{3}$/.test(id)) {
      const n = Number(id);
      if (!Number.isFinite(n) || n < 1 || n > 999) return null;
      return padNumber(n, 3);
    }
    return null;
  }

  // ============================================================================
  //  UI state (local)
  // ============================================================================

  function defaultUiState() {
    return { filter: "all", view: "album", collapsedSections: {} };
  }

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_PREFS_KEY);
      const parsed = safeParseJSON(raw);
      const next = defaultUiState();
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.filter === "string") next.filter = parsed.filter;
        if (typeof parsed.view === "string") next.view = parsed.view;
        if (parsed.collapsedSections && typeof parsed.collapsedSections === "object") {
          next.collapsedSections = { ...parsed.collapsedSections };
        }
      }
      if (!["all", "missing", "dupes"].includes(next.filter)) next.filter = "all";
      if (!["album", "stats", "sync", "settings"].includes(next.view)) next.view = "album";
      return next;
    } catch {
      return defaultUiState();
    }
  }

  function saveUiState() {
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiState));
    } catch {
      // ignore
    }
  }

  const uiState = loadUiState();

  // ============================================================================
  //  Progress state (in-memory, truth comes from Supabase)
  // ============================================================================

  // progress format (remote):
  // {
  //   stickers: { "001": { owned:true, duplicates:0 }, ... },
  //   lastUpdated: "ISO",
  //   lastUpdatedBy: "client_..."
  // }
  let progress = { stickers: {}, lastUpdated: null, lastUpdatedBy: null };

  // Remote metadata
  let collectionRow = { id: null, updated_at: null, album_name: null };

  function coerceStickerEntry(entry) {
    const owned = Boolean(entry && entry.owned);
    const dupRaw = entry && Number.isFinite(entry.duplicates) ? entry.duplicates : 0;
    const duplicates = Math.max(0, Math.floor(dupRaw));
    const updatedAt = entry && typeof entry.updatedAt === "string" ? entry.updatedAt : null;
    return updatedAt ? { owned, duplicates, updatedAt } : { owned, duplicates };
  }

  function getEntry(id) {
    const e = progress.stickers[id];
    return e ? coerceStickerEntry(e) : { owned: false, duplicates: 0 };
  }

  function setEntry(id, next) {
    const canonicalId = canonicalizeStickerId(id);
    if (!canonicalId || !IDS.has(canonicalId)) return;
    progress.stickers[canonicalId] = coerceStickerEntry(next);
    progress.lastUpdated = new Date().toISOString();
    progress.lastUpdatedBy = clientId;

    cacheProgress();
    scheduleRemoteSave();
    render();
  }

  // ============================================================================
  //  Local cache (UX only)
  // ============================================================================

  function cacheProgress() {
    try {
      const payload = {
        cachedAt: new Date().toISOString(),
        access_code: COLLECTION_ACCESS_CODE,
        progress,
        updated_at: collectionRow.updated_at,
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  function loadCachedProgress() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = safeParseJSON(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (parsed.access_code !== COLLECTION_ACCESS_CODE) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function applyRemoteProgress(remoteProgress) {
    const next = { stickers: {}, lastUpdated: null, lastUpdatedBy: null };
    if (remoteProgress && typeof remoteProgress === "object") {
      const stickers = remoteProgress.stickers && typeof remoteProgress.stickers === "object" ? remoteProgress.stickers : {};
      for (const [id, entry] of Object.entries(stickers)) {
        const canonicalId = canonicalizeStickerId(id);
        if (!canonicalId || !IDS.has(canonicalId)) continue;
        next.stickers[canonicalId] = coerceStickerEntry(entry);
      }
      next.lastUpdated = typeof remoteProgress.lastUpdated === "string" ? remoteProgress.lastUpdated : null;
      next.lastUpdatedBy = typeof remoteProgress.lastUpdatedBy === "string" ? remoteProgress.lastUpdatedBy : null;
    }
    progress = next;
  }

  // ============================================================================
  //  Supabase
  // ============================================================================

  function isValidHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function isSupabaseConfigReady() {
    return (
      typeof SUPABASE_URL === "string" &&
      SUPABASE_URL.trim() !== "" &&
      isValidHttpUrl(SUPABASE_URL) &&
      typeof SUPABASE_ANON_KEY === "string" &&
      SUPABASE_ANON_KEY.trim() !== "" &&
      typeof COLLECTION_ACCESS_CODE === "string" &&
      COLLECTION_ACCESS_CODE.trim() !== ""
    );
  }

  let sb = null;
  let sbInitAttempted = false;

  function getSupabaseClient() {
    if (sb) return sb;
    if (sbInitAttempted) return null;
    sbInitAttempted = true;

    if (!isSupabaseConfigReady()) return null;
    if (!window.supabase || typeof window.supabase.createClient !== "function") return null;

    try {
      const { createClient } = window.supabase;
      sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      return sb;
    } catch (err) {
      // Nunca dejamos que un error de configuración bloquee el render inicial.
      console.error("Supabase client init error", err);
      cloudMode = "config_error";
      cloudMessage = "Config Supabase inválida";
      setSyncStatus("error", "Config Supabase inválida");
      toast("⚠️", "Config Supabase inválida", "SUPABASE_URL debe empezar por https:// (o http://) y ser válida.");
      return null;
    }
  }

  let realtimeChannel = null;
  let pollTimer = null;
  let saveTimer = null;
  let inFlightSave = false;
  let lastLocalSaveAt = 0;
  let remoteReady = false;
  let cloudMode = "loading"; // loading | online | offline | missing | config_error
  let cloudMessage = "Cargando colección…";

  async function fetchCollection() {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase no configurado");
    const { data, error } = await client
      .from("sticker_collections")
      .select("id, access_code, album_name, progress, updated_at")
      .eq("access_code", COLLECTION_ACCESS_CODE)
      .limit(1);

    if (error) throw error;
    return data && data.length ? data[0] : null;
  }

  function isNewerServerUpdate(updatedAt) {
    if (!updatedAt) return false;
    if (!collectionRow.updated_at) return true;
    return new Date(updatedAt).getTime() > new Date(collectionRow.updated_at).getTime();
  }

  async function loadFromSupabase() {
    console.log("Loading collection from Supabase...");
    cloudMode = "loading";
    cloudMessage = "Cargando colección…";
    setSyncStatus("loading", cloudMessage);

    try {
      const row = await withTimeout(fetchCollection(), SUPABASE_LOAD_TIMEOUT_MS, "Supabase load timeout");
      if (!row) {
        cloudMode = "missing";
        cloudMessage = "No se encontró la colección (access_code)";
        setSyncStatus("error", cloudMessage);
        console.warn("Supabase collection missing");
        toast("⚠️", "Colección no encontrada", "No se encontró la colección con el access_code configurado.");
        // La app sigue usable: no retornamos sin render.
        return;
      }

      console.log("Supabase collection loaded");
      collectionRow = { id: row.id, updated_at: row.updated_at, album_name: row.album_name || null };
      applyRemoteProgress(row.progress);
      cacheProgress();
      remoteReady = true;

      cloudMode = "online";
      cloudMessage = "Guardado en la nube";
      setSyncStatus("saved", "Conectado");
      render();

      subscribeRealtime();
      startPollingFallback();
    } catch (err) {
      cloudMode = "offline";
      cloudMessage = "Modo sin conexión";
      console.error("Supabase load error", err);
      setSyncStatus("offline", "Modo sin conexión");
      toast(
        "📡",
        "No se pudo conectar con Supabase",
        "Puedes usar el checklist, pero los cambios no se guardarán en la nube."
      );
    } finally {
      // Asegura que la UI no quede congelada
      try {
        render();
      } catch (e) {
        console.error("Render error after Supabase load", e);
      }
    }
  }

  function buildRemoteProgressPayload() {
    return {
      stickers: progress.stickers,
      lastUpdated: progress.lastUpdated || new Date().toISOString(),
      lastUpdatedBy: progress.lastUpdatedBy || clientId,
    };
  }

  function scheduleRemoteSave() {
    if (!collectionRow.id) return; // no cargado aún
    if (saveTimer) clearTimeout(saveTimer);
    setSyncStatus("saving", "Guardando…");
    saveTimer = setTimeout(() => {
      void saveToSupabase();
    }, SAVE_DEBOUNCE_MS);
  }

  async function saveToSupabase() {
    if (!collectionRow.id) return;
    if (inFlightSave) return;
    inFlightSave = true;
    lastLocalSaveAt = Date.now();

    const payload = buildRemoteProgressPayload();

    try {
      const client = getSupabaseClient();
      if (!client) throw new Error("Supabase no configurado");
      const { data, error } = await client
        .from("sticker_collections")
        .update({ progress: payload })
        .eq("access_code", COLLECTION_ACCESS_CODE)
        .select("id, updated_at, progress")
        .limit(1);

      if (error) throw error;
      const row = data && data.length ? data[0] : null;
      if (row && row.updated_at) {
        collectionRow.updated_at = row.updated_at;
      }
      cacheProgress();
      cloudMode = "online";
      setSyncStatus("saved", "Guardado");
    } catch (err) {
      cloudMode = "offline";
      setSyncStatus("error", "Error al guardar");
      toast("⚠️", "Error al guardar", `${err && err.message ? err.message : "Revisa RLS/clave anon."}`);
    } finally {
      inFlightSave = false;
    }
  }

  function subscribeRealtime() {
    const client = getSupabaseClient();
    if (!client || typeof client.channel !== "function") return;
    if (realtimeChannel) return;

    realtimeChannel = client
      .channel("sticker_collections_changes")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sticker_collections",
          filter: `access_code=eq.${COLLECTION_ACCESS_CODE}`,
        },
        (payload) => {
          const next = payload && payload.new ? payload.new : null;
          if (!next) return;

          // Ignora eco de tu propio update (si el otro cliente conserva lastUpdatedBy)
          const remoteProgress = next.progress || {};
          if (remoteProgress && remoteProgress.lastUpdatedBy && remoteProgress.lastUpdatedBy === clientId) return;

          // Evita sobreescribir cambios recientes locales por un update más viejo
          if (!isNewerServerUpdate(next.updated_at)) return;
          if (Date.now() - lastLocalSaveAt < 1200) return;

          collectionRow.updated_at = next.updated_at || collectionRow.updated_at;
          applyRemoteProgress(remoteProgress);
          cacheProgress();
          render();
          setSyncStatus("saved", "Actualizado desde otro dispositivo");
          toast("🔁", "Sincronizado", "Hubo cambios desde otro dispositivo.");
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setSyncStatus("saved", "Conectado (Realtime)");
        }
      });
  }

  function startPollingFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      // Si hay realtime, igual dejamos polling ligero como respaldo.
      try {
        const row = await fetchCollection();
        if (!row) return;
        if (!isNewerServerUpdate(row.updated_at)) return;
        if (Date.now() - lastLocalSaveAt < 1200) return;
        if (row.progress && row.progress.lastUpdatedBy === clientId) return;

        collectionRow.updated_at = row.updated_at;
        applyRemoteProgress(row.progress);
        cacheProgress();
        render();
        cloudMode = "online";
        setSyncStatus("saved", "Sincronizado");
      } catch {
        cloudMode = "offline";
        setSyncStatus("offline", "Sin conexión (reintentando…)"); // sin toast para no molestar
      }
    }, POLL_INTERVAL_MS);
  }

  // ============================================================================
  //  Rendering
  // ============================================================================

  function computeStats() {
    const total = ITEMS.length;
    let ownedCount = 0;
    let dupes = 0;
    for (const it of ITEMS) {
      const e = getEntry(it.id);
      if (e.owned) ownedCount += 1;
      dupes += e.duplicates;
    }
    const missing = total - ownedCount;
    const percent = total === 0 ? 0 : (ownedCount / total) * 100;
    return { total, ownedCount, missing, dupes, percent };
  }

  function matchesFilter(item, filter) {
    const e = getEntry(item.id);
    switch (filter) {
      case "missing":
        return e.owned === false;
      case "dupes":
        return e.duplicates > 0;
      case "all":
      default:
        return true;
    }
  }

  function visibleItems() {
    return ITEMS.filter((it) => matchesFilter(it, uiState.filter));
  }

  function renderDashboard() {
    const { total, ownedCount, missing, dupes, percent } = computeStats();
    if (els.metricHave) els.metricHave.textContent = String(ownedCount);
    if (els.metricMissing) els.metricMissing.textContent = String(missing);
    if (els.metricDupes) els.metricDupes.textContent = String(dupes);

    if (els.summaryLine) els.summaryLine.textContent = `Tienes ${ownedCount} de ${total} cromos`;

    if (els.progressText) els.progressText.textContent = `${percent.toFixed(1)}%`;
    if (els.progressBar) els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (els.progressRail) {
      els.progressRail.setAttribute("aria-valuenow", percent.toFixed(1));
      els.progressRail.setAttribute("aria-label", `Progreso: ${percent.toFixed(1)}%`);
    }
  }

  function filterLabel(filter) {
    switch (filter) {
      case "missing":
        return "Me faltan";
      case "dupes":
        return "Repetidas";
      case "all":
      default:
        return "Todas";
    }
  }

  function computeSectionStats(sectionId) {
    const items = ITEMS.filter((x) => x.sectionId === sectionId);
    const total = items.length;
    let ownedCount = 0;
    let dupes = 0;
    for (const it of items) {
      const e = getEntry(it.id);
      if (e.owned) ownedCount += 1;
      dupes += e.duplicates;
    }
    return { total, ownedCount, dupes };
  }

  function sectionIcon(sectionId) {
    if (sectionId === "poster") return "🧩";
    return "📗";
  }

  function getSectionLabel(sectionId) {
    const s = ALBUM_CONFIG.officialSections.find((x) => x.id === sectionId) || ALBUM_CONFIG.extendedSections.find((x) => x.id === sectionId);
    return s ? s.label : sectionId;
  }

  function renderStickerTile(item) {
    const e = getEntry(item.id);
    const owned = e.owned === true;
    const dupes = e.duplicates || 0;
    const badge = dupes > 0 ? `<div class="dupe-badge" aria-label="Repetidas: ${dupes}">${dupes > 9 ? "9+" : dupes}</div>` : "";
    const classes = ["sticker-tile", owned ? "is-owned" : "is-missing", dupes > 0 ? "has-dupes" : ""].join(" ");
    return `
      <button class="${classes}" type="button" data-sticker-id="${escapeHtml(item.id)}" aria-label="Ficha ${escapeHtml(
      item.id
    )}. ${owned ? "Conseguida" : "Faltante"}. ${dupes > 0 ? `Repetidas ${dupes}.` : ""}">
        <span class="tile-screws" aria-hidden="true"></span>
        <span class="tile-question" aria-hidden="true">?</span>
        <span class="tile-number">${escapeHtml(item.id)}</span>
        ${badge}
      </button>
    `;
  }

  function sectionItemsVisible(sectionId) {
    return ITEMS.filter((it) => it.sectionId === sectionId).filter((it) => matchesFilter(it, uiState.filter));
  }

  function renderAlbumView() {
    if (!els.albumView) return;

    const sectionIds = Array.from(new Set(ITEMS.map((x) => x.sectionId)));
    const parts = [];
    for (const sectionId of sectionIds) {
      const visible = sectionItemsVisible(sectionId);
      const { total, ownedCount } = computeSectionStats(sectionId);
      const collapsed = Boolean(uiState.collapsedSections && uiState.collapsedSections[sectionId]);

      parts.push(`
        <section class="album-section" data-section-id="${escapeHtml(sectionId)}">
          <header class="section-header">
            <h2 class="section-title">
              <span class="sec-ico" aria-hidden="true">${sectionIcon(sectionId)}</span>
              <span>${escapeHtml(getSectionLabel(sectionId))}</span>
            </h2>
            <div class="section-progress">
              <span class="sec-count">${ownedCount} / ${total}</span>
              <button class="sec-toggle" type="button" data-action="toggle-section" data-section="${escapeHtml(
                sectionId
              )}">${collapsed ? "Expandir" : "Colapsar"}</button>
            </div>
          </header>
          ${collapsed ? "" : `<div class="sticker-grid-compact">${visible.map(renderStickerTile).join("")}</div>`}
        </section>
      `);
    }

    els.albumView.innerHTML = parts.join("");
  }

  function renderStatsView() {
    if (!els.statsView) return;
    const stats = computeStats();

    const main = computeSectionStats("main");
    const poster = computeSectionStats("poster");

    const percent = Math.max(0, Math.min(100, stats.percent));
    const ring = `
      <div style="display:flex; gap:12px; align-items:center; justify-content:space-between;">
        <div class="progress-ring" style="--p:${percent}%">
          <div class="ring-label">${percent.toFixed(1)}%</div>
        </div>
        <div style="flex:1;">
          <div class="tile-subtle">Progreso general</div>
          <div class="bar" aria-label="Progreso general"><div style="width:${percent}%"></div></div>
          <div style="margin-top:10px; display:grid; gap:8px;">
            <div class="tile-subtle">Álbum principal</div>
            <div class="bar"><div style="width:${main.total ? (main.ownedCount / main.total) * 100 : 0}%"></div></div>
            <div class="tile-subtle">Póster / M</div>
            <div class="bar"><div style="width:${poster.total ? (poster.ownedCount / poster.total) * 100 : 0}%"></div></div>
          </div>
        </div>
      </div>
    `;

    const topDupes = ITEMS
      .map((it) => ({ id: it.id, dupes: getEntry(it.id).duplicates }))
      .filter((x) => x.dupes > 0)
      .sort((a, b) => b.dupes - a.dupes)
      .slice(0, 8);

    const topDupesMarkup =
      topDupes.length === 0
        ? `<div class="tile-subtle">Aún no tienes repetidas.</div>`
        : `<div class="list">${topDupes
            .map((x) => `<div class="list-item"><strong>${escapeHtml(x.id)}</strong><span>x${x.dupes}</span></div>`)
            .join("")}</div>`;

    els.statsView.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-title">Completado</div>
          <div class="stat-value">${stats.percent.toFixed(1)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Total</div>
          <div class="stat-value">${stats.total}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Me faltan</div>
          <div class="stat-value">${stats.missing}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Tengo</div>
          <div class="stat-value">${stats.ownedCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Repetidas (total)</div>
          <div class="stat-value">${stats.dupes}</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Secciones</div>
          <div class="stat-value" style="font-size:14px; letter-spacing:0;">
            Álbum: ${main.ownedCount} / ${main.total}<br />
            Póster: ${poster.ownedCount} / ${poster.total}
          </div>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-title">Progreso visual</div>
          <div style="margin-top:10px;">${ring}</div>
        </div>

        <div class="stat-card">
          <div class="stat-title">Top repetidas</div>
          <div style="margin-top:10px;">${topDupesMarkup}</div>
        </div>
      </div>
    `;
  }

  function renderSyncView() {
    if (!els.syncView) return;
    const lastRemote = collectionRow && collectionRow.updated_at ? new Date(collectionRow.updated_at).toLocaleString() : "—";
    const lastLocal = progress && progress.lastUpdated ? new Date(progress.lastUpdated).toLocaleString() : "—";
    els.syncView.innerHTML = `
      <div class="stat-card">
        <div class="stat-title">Estado</div>
        <div class="stat-value" style="font-size:16px; letter-spacing:0;">${escapeHtml(cloudMessage)}</div>
        <div class="help">Último guardado local: <strong>${escapeHtml(lastLocal)}</strong></div>
        <div class="help">Último update remoto: <strong>${escapeHtml(lastRemote)}</strong></div>
        <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-primary" type="button" data-action="force-reload">Forzar recarga desde Supabase</button>
        </div>
      </div>
    `;
  }

  function renderSettingsView() {
    if (!els.settingsView) return;
    const masked = `${COLLECTION_ACCESS_CODE.slice(0, 4)}…${COLLECTION_ACCESS_CODE.slice(-4)}`;
    els.settingsView.innerHTML = `
      <div class="stat-card">
        <div class="stat-title">Progreso</div>
        <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-primary" type="button" data-action="export">Exportar JSON</button>
          <button class="btn" type="button" data-action="import">Importar JSON</button>
          <button class="btn btn-danger" type="button" data-action="reset-all">Resetear progreso</button>
        </div>
        <div class="help" style="margin-top:10px;">La fuente de verdad es Supabase. Importar/Resetear también sincroniza a la colección compartida.</div>
      </div>

      <div class="stat-card" style="margin-top:12px;">
        <div class="stat-title">Colección</div>
        <div class="stat-value" style="font-size:14px; letter-spacing:0;">access_code: <strong>${escapeHtml(masked)}</strong></div>
        <div class="help">Nota: este código está embebido en el frontend. Para seguridad real, usa Auth o una función serverless.</div>
      </div>
    `;
  }

  function renderTabs() {
    for (const btn of els.tabs || []) {
      const f = btn.getAttribute("data-filter") || "all";
      const active = f === uiState.filter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.setAttribute("tabindex", active ? "0" : "-1");
    }
  }

  function renderViews() {
    const view = uiState.view || "album";
    if (els.albumView) els.albumView.classList.toggle("is-active", view === "album");
    if (els.statsView) els.statsView.classList.toggle("is-active", view === "stats");
    if (els.syncView) els.syncView.classList.toggle("is-active", view === "sync");
    if (els.settingsView) els.settingsView.classList.toggle("is-active", view === "settings");

    $$(".bottom-nav .nav-btn").forEach((btn) => {
      const v = btn.getAttribute("data-view");
      btn.classList.toggle("is-active", v === view);
    });

    if (view === "album") renderAlbumView();
    if (view === "stats") renderStatsView();
    if (view === "sync") renderSyncView();
    if (view === "settings") renderSettingsView();
  }

  function render() {
    try {
      renderDashboard();
      renderTabs();
      renderViews();
    } catch (err) {
      console.error("Render error", err);
    }
  }

  // ============================================================================
  //  Toast
  // ============================================================================

  let toastTimer = null;
  function toast(icon, title, meta = "") {
    if (!els.toastRegion) return;
    if (toastTimer) clearTimeout(toastTimer);
    els.toastRegion.innerHTML = `
      <div class="toast" role="status">
        <div class="ticon" aria-hidden="true">${icon}</div>
        <div>
          <div class="ttext">${escapeHtml(title)}</div>
          ${meta ? `<div class="tmeta">${escapeHtml(meta)}</div>` : ""}
        </div>
      </div>
    `;
    toastTimer = setTimeout(() => {
      els.toastRegion.innerHTML = "";
    }, 2200);
  }

  // ============================================================================
  //  Actions: copy lists / export-import / reset / search
  // ============================================================================

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fallback below
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function buildMissingList() {
    return ITEMS.filter((it) => !getEntry(it.id).owned).map((it) => it.id);
  }

  function buildDupesList() {
    return ITEMS.filter((it) => getEntry(it.id).duplicates > 0).map((it) => `${it.id} x${getEntry(it.id).duplicates}`);
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportProgress() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const payload = {
      app: "Super Mario Sticker Checklist",
      exportedAt: now.toISOString(),
      access_code: COLLECTION_ACCESS_CODE,
      progress: buildRemoteProgressPayload(),
    };
    downloadJSON(`super-mario-stickers-progress_${stamp}.json`, payload);
    toast("📦", "Exportado", "Se descargó tu progreso en JSON.");
  }

  async function importProgressFromFile(file) {
    try {
      const text = await file.text();
      const parsed = safeParseJSON(text);
      const incoming = parsed && parsed.progress ? parsed.progress : parsed;
      if (!incoming || typeof incoming !== "object") {
        toast("⚠️", "Importación fallida", "El JSON no tiene un formato válido.");
        return;
      }
      applyRemoteProgress(incoming);
      progress.lastUpdated = new Date().toISOString();
      progress.lastUpdatedBy = clientId;
      cacheProgress();
      render();
      if (collectionRow.id) {
        toast("✅", "Importado", "Progreso aplicado. Guardando en Supabase…");
        scheduleRemoteSave();
      } else {
        toast("✅", "Importado", "Progreso aplicado localmente (sin conexión a la nube).");
      }
    } catch {
      toast("⚠️", "Importación fallida", "No pude leer/parsear ese archivo.");
    } finally {
      if (els.importFile) els.importFile.value = "";
    }
  }

  function resetProgress() {
    const ok = window.confirm(
      "¿Seguro que quieres resetear el progreso?\n\nEsto borrará cromos marcados y repetidas en la colección compartida."
    );
    if (!ok) return;
    progress = { stickers: {}, lastUpdated: new Date().toISOString(), lastUpdatedBy: clientId };
    cacheProgress();
    render();
    if (collectionRow.id) {
      toast("🧨", "Progreso reseteado", "Guardando en Supabase…");
      scheduleRemoteSave();
    } else {
      toast("🧨", "Progreso reseteado", "Listo (sin conexión a la nube).");
    }
  }

  function jumpToSticker(input) {
    const id = normalizeSearchId(input);
    if (!id) {
      toast("🔎", "Búsqueda inválida", "Ej: 045, 45, M12 o LE3.");
      return;
    }
    if (!IDS.has(id)) {
      // Si es extra y está desactivado, lo comunicamos
      if (!ENABLE_EXTENDED_COLLECTION && (id.startsWith("LE") || id.startsWith("O"))) {
        toast("🔒", "Extras desactivados", "Activa ENABLE_EXTENDED_COLLECTION en app.js.");
        return;
      }
      toast("❓", "No existe en esta colección", `No encuentro ${id}.`);
      return;
    }

    uiState.view = "album";
    uiState.filter = "all";
    if (uiState.collapsedSections) uiState.collapsedSections = { ...uiState.collapsedSections, main: false, poster: false };
    saveUiState();
    render();

    requestAnimationFrame(() => {
      const tile = document.querySelector(`[data-sticker-id="${CSS.escape(id)}"]`);
      if (!tile) return;
      tile.classList.remove("tile-highlight");
      void tile.offsetWidth;
      tile.classList.add("tile-highlight");
      tile.scrollIntoView({ behavior: "smooth", block: "center" });
      toast("🎯", "Encontrado", `Salté a ${id}.`);
      if (tile instanceof HTMLElement) tile.focus({ preventScroll: true });
      setTimeout(() => tile.classList.remove("tile-highlight"), 1400);
    });
  }

  // ============================================================================
  //  Events
  // ============================================================================

  const LONG_PRESS_MS = 550;
  const pressState = {
    timer: null,
    pointerId: null,
    targetId: null,
    didLongPress: false,
  };

  let modalState = { id: null, dupes: 0 };

  function handleStickerTap(id) {
    const current = getEntry(id);
    if (!current.owned) {
      setEntry(id, { owned: true, duplicates: 0, updatedAt: new Date().toISOString() });
      toast("✅", "Conseguida", `${id}`);
      return;
    }
    setEntry(id, { owned: true, duplicates: current.duplicates + 1, updatedAt: new Date().toISOString() });
    toast("🪙", "Repetida sumada", `${id} ahora tiene ${current.duplicates + 1}.`);
  }

  function openStickerModal(id) {
    const cid = canonicalizeStickerId(id);
    if (!cid || !IDS.has(cid) || !els.stickerModal) return;
    const item = ITEMS.find((x) => x.id === cid);
    const entry = getEntry(cid);

    modalState = { id: cid, dupes: entry.duplicates };

    if (els.modalStickerId) els.modalStickerId.textContent = cid;
    if (els.modalStickerSection) els.modalStickerSection.textContent = item ? item.sectionLabel : "—";
    if (els.modalOwned) els.modalOwned.checked = Boolean(entry.owned);
    if (els.modalDupes) els.modalDupes.textContent = String(entry.duplicates);

    els.stickerModal.hidden = false;
    document.body.style.overflow = "hidden";
    const closeBtn = els.stickerModal.querySelector('[data-action="close-modal"]');
    if (closeBtn instanceof HTMLElement) closeBtn.focus();
  }

  function closeStickerModal() {
    if (!els.stickerModal) return;
    els.stickerModal.hidden = true;
    document.body.style.overflow = "";
    modalState = { id: null, dupes: 0 };
  }

  function modalSetDupes(next) {
    const v = Math.max(0, Math.floor(next));
    modalState.dupes = v;
    if (els.modalDupes) els.modalDupes.textContent = String(v);
    if (els.modalOwned && v > 0) els.modalOwned.checked = true;
  }

  function updateStickerFromModal() {
    const id = modalState.id;
    if (!id) return;
    const owned = Boolean(els.modalOwned && els.modalOwned.checked);
    const dupes = Math.max(0, Math.floor(modalState.dupes || 0));
    const nextOwned = dupes > 0 ? true : owned;
    const nextDupes = nextOwned ? dupes : 0;
    setEntry(id, { owned: nextOwned, duplicates: nextDupes, updatedAt: new Date().toISOString() });
    toast("💾", "Guardado", `${id}`);
    closeStickerModal();
  }

  function resetStickerFromModal() {
    const id = modalState.id;
    if (!id) return;
    setEntry(id, { owned: false, duplicates: 0, updatedAt: new Date().toISOString() });
    toast("🧽", "Reseteada", `${id}`);
    closeStickerModal();
  }

  async function forceReloadFromSupabase() {
    toast("🔄", "Recargando…", "Consultando Supabase.");
    await loadFromSupabase();
  }

  function bindEvents() {
    // Tabs (filters)
    for (const btn of els.tabs || []) {
      btn.addEventListener("click", () => {
        uiState.filter = btn.getAttribute("data-filter") || "all";
        saveUiState();
        render();
        toast("🔎", "Filtro aplicado", `Ahora: ${filterLabel(uiState.filter)}.`);
      });
    }

    if (els.orderBtn) {
      els.orderBtn.addEventListener("click", () => {
        toast("🧭", "Orden", "Visual listo. Puedes agregar orden avanzado luego.");
      });
    }

    // Bottom nav
    if (els.bottomNav) {
      els.bottomNav.addEventListener("click", (e) => {
        const t = e.target instanceof Element ? e.target.closest("[data-view]") : null;
        if (!t) return;
        const view = t.getAttribute("data-view");
        if (!view) return;
        uiState.view = view;
        saveUiState();
        render();
      });
    }

    // Album interactions: tap / long-press
    if (els.albumView) {
      els.albumView.addEventListener("click", (e) => {
        const tile = e.target instanceof Element ? e.target.closest("[data-sticker-id]") : null;
        if (!tile) return;
        const id = tile.getAttribute("data-sticker-id");
        if (!id) return;
        if (pressState.didLongPress) {
          pressState.didLongPress = false;
          return;
        }
        handleStickerTap(id);
      });

      els.albumView.addEventListener("pointerdown", (e) => {
        const tile = e.target instanceof Element ? e.target.closest("[data-sticker-id]") : null;
        if (!tile || !(tile instanceof HTMLElement)) return;
        const id = tile.getAttribute("data-sticker-id");
        if (!id) return;

        pressState.didLongPress = false;
        pressState.pointerId = e.pointerId;
        pressState.targetId = id;
        if (pressState.timer) clearTimeout(pressState.timer);
        tile.classList.add("is-pressing");

        pressState.timer = setTimeout(() => {
          pressState.didLongPress = true;
          tile.classList.add("is-pressing");
          openStickerModal(id);
        }, LONG_PRESS_MS);
      });

      const clearPress = (e) => {
        if (pressState.timer) clearTimeout(pressState.timer);
        pressState.timer = null;
        const id = pressState.targetId;
        pressState.targetId = null;
        if (!id) return;
        const tile = document.querySelector(`[data-sticker-id="${CSS.escape(id)}"]`);
        if (tile instanceof HTMLElement) tile.classList.remove("is-pressing");
      };

      els.albumView.addEventListener("pointerup", clearPress);
      els.albumView.addEventListener("pointercancel", clearPress);
      els.albumView.addEventListener("pointerleave", clearPress);

      els.albumView.addEventListener("contextmenu", (e) => {
        const tile = e.target instanceof Element ? e.target.closest("[data-sticker-id]") : null;
        if (!tile) return;
        e.preventDefault();
        const id = tile.getAttribute("data-sticker-id");
        if (id) openStickerModal(id);
      });

      els.albumView.addEventListener("click", (e) => {
        const toggle = e.target instanceof Element ? e.target.closest('[data-action="toggle-section"]') : null;
        if (!toggle) return;
        const sectionId = toggle.getAttribute("data-section");
        if (!sectionId) return;
        uiState.collapsedSections = uiState.collapsedSections || {};
        uiState.collapsedSections[sectionId] = !uiState.collapsedSections[sectionId];
        saveUiState();
        render();
      });
    }

    // Search
    if (els.searchBtn && els.searchInput) {
      els.searchBtn.addEventListener("click", () => jumpToSticker(els.searchInput.value));
      els.searchInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") jumpToSticker(els.searchInput.value);
      });
    }
    if (els.clearSearchBtn && els.searchInput) {
      els.clearSearchBtn.addEventListener("click", () => {
        els.searchInput.value = "";
        els.searchInput.focus();
        toast("🧽", "Buscador limpio", "");
      });
    }

    // Modal
    if (els.stickerModal) {
      els.stickerModal.addEventListener("click", (e) => {
        const actionEl = e.target instanceof Element ? e.target.closest("[data-action]") : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute("data-action");
        if (!action) return;
        if (action === "close-modal") return closeStickerModal();
        if (action === "modal-dupe-inc") return modalSetDupes(modalState.dupes + 1);
        if (action === "modal-dupe-dec") return modalSetDupes(modalState.dupes - 1);
        if (action === "modal-save") return updateStickerFromModal();
        if (action === "modal-reset") return resetStickerFromModal();
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && els.stickerModal && !els.stickerModal.hidden) closeStickerModal();
      });

      if (els.modalOwned) {
        els.modalOwned.addEventListener("change", () => {
          if (els.modalOwned && els.modalOwned.checked === false) {
            modalSetDupes(0);
          }
        });
      }
    }

    // Sync + Settings actions (delegation)
    document.addEventListener("click", async (e) => {
      const el = e.target instanceof Element ? e.target.closest("[data-action]") : null;
      if (!el) return;
      const action = el.getAttribute("data-action");
      if (!action) return;

      if (action === "force-reload") {
        await forceReloadFromSupabase();
        return;
      }

      if (action === "export") {
        exportProgress();
        return;
      }
      if (action === "import") {
        if (els.importFile) els.importFile.click();
        return;
      }
      if (action === "reset-all") {
        resetProgress();
        return;
      }
    });

    // Import file
    if (els.importFile) {
      els.importFile.addEventListener("click", () => {
        els.importFile.value = "";
      });
      els.importFile.addEventListener("change", async () => {
        const file = els.importFile.files && els.importFile.files[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".json")) {
          toast("⚠️", "Archivo inválido", "Selecciona un JSON exportado por la app.");
          els.importFile.value = "";
          return;
        }
        await importProgressFromFile(file);
      });
    }
  }

  // ============================================================================
  //  Init
  // ============================================================================

  function init() {
    console.log("Initializing app...");
    try {
      // Render inicial: usa caché si existe (UX), pero igual consulta Supabase SIEMPRE.
      const cached = loadCachedProgress();
      if (cached && cached.progress) {
        applyRemoteProgress(cached.progress);
        setSyncStatus("loading", "Cargando colección… (mostrando caché)");
      } else {
        setSyncStatus("loading", "Cargando colección…");
      }

      render();
      bindEvents();

      // No bloquea el checklist si Supabase no está listo/configurado.
      if (!isSupabaseConfigReady()) {
        cloudMode = "config_error";
        console.warn("Supabase config not ready or supabase-js not loaded");
        setSyncStatus("error", "Config Supabase incompleta");
        toast(
          "⚠️",
          "Config Supabase incompleta",
          "Edita SUPABASE_URL (https://...) y SUPABASE_ANON_KEY en app.js."
        );
        // No bloquea el checklist
        return;
      }

      const client = getSupabaseClient();
      if (!client) {
        // getSupabaseClient() ya reporta el error (toast + pill) si aplica.
        return;
      }

      void loadFromSupabase();
    } catch (err) {
      console.error("Init error", err);
      setSyncStatus("offline", "Modo sin conexión");
      render();
      toast("📡", "Modo sin conexión", "El checklist sigue disponible.");
    }
  }

  init();
})();
