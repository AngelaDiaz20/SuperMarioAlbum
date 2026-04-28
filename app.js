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
  const SUPABASE_URL = "https://ydcgppqaftxnioeeduhj.supabase.co/rest/v1/";
  const SUPABASE_ANON_KEY = "Its_a_me_mario";
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
    grid: $("#grid"),
    toastRegion: $("#toastRegion"),

    metricTotal: $("#metricTotal"),
    metricHave: $("#metricHave"),
    metricMissing: $("#metricMissing"),
    metricDupes: $("#metricDupes"),
    summaryLine: $("#summaryLine"),
    summaryMissing: $("#summaryMissing"),
    summaryDupes: $("#summaryDupes"),
    summaryPercent: $("#summaryPercent"),
    progressText: $("#progressText"),
    progressBar: $("#progressBar"),
    progressRail: $(".progress-rail"),

    visibleCountPill: $("#visibleCountPill"),
    activeFilterPill: $("#activeFilterPill"),

    syncStatusPill: $("#syncStatusPill"),

    searchInput: $("#searchInput"),
    searchBtn: $("#searchBtn"),
    clearSearchBtn: $("#clearSearchBtn"),

    copyMissingBtn: $("#copyMissingBtn"),
    copyDupesBtn: $("#copyDupesBtn"),
    exportBtn: $("#exportBtn"),
    importBtn: $("#importBtn"),
    importFile: $("#importFile"),
    resetBtn: $("#resetBtn"),
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
    return { filter: "all" };
  }

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_PREFS_KEY);
      const parsed = safeParseJSON(raw);
      const next = defaultUiState();
      if (parsed && typeof parsed === "object" && typeof parsed.filter === "string") next.filter = parsed.filter;
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
    return { owned, duplicates };
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
      SUPABASE_URL &&
      isValidHttpUrl(SUPABASE_URL) &&
      SUPABASE_ANON_KEY &&
      !SUPABASE_URL.includes("PEGAR_SUPABASE_URL_AQUI") &&
      !SUPABASE_ANON_KEY.includes("PEGAR_SUPABASE_ANON_KEY_AQUI")
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
      case "have":
        return e.owned === true;
      case "missing":
        return e.owned === false;
      case "dupes":
        return e.duplicates > 0;
      case "main":
        return item.sectionId === "main";
      case "poster":
        return item.sectionId === "poster";
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
    if (els.metricTotal) els.metricTotal.textContent = String(total);
    if (els.metricHave) els.metricHave.textContent = String(ownedCount);
    if (els.metricMissing) els.metricMissing.textContent = String(missing);
    if (els.metricDupes) els.metricDupes.textContent = String(dupes);

    if (els.summaryLine) els.summaryLine.textContent = `Tienes ${ownedCount} de ${total} cromos`;
    if (els.summaryMissing) els.summaryMissing.textContent = `Faltan ${missing}`;
    if (els.summaryDupes) els.summaryDupes.textContent = `Repetidas: ${dupes}`;
    if (els.summaryPercent) els.summaryPercent.textContent = `Progreso: ${percent.toFixed(1)}%`;

    if (els.progressText) els.progressText.textContent = `${percent.toFixed(1)}%`;
    if (els.progressBar) els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (els.progressRail) {
      els.progressRail.setAttribute("aria-valuenow", percent.toFixed(1));
      els.progressRail.setAttribute("aria-label", `Progreso: ${percent.toFixed(1)}%`);
    }
  }

  function stickerMiniMarkup(id) {
    const fallback = id.startsWith("M") ? "🧩" : "🟦";
    const safeAlt = "";
    return `
      <div class="sticker-mini" aria-hidden="true">
        <img src="./assets/sticker-placeholder.png" alt="${safeAlt}" loading="lazy" decoding="async"
          onerror="this.remove(); this.parentElement.insertAdjacentHTML('beforeend','<div class=&quot;mini-fallback&quot; aria-hidden=&quot;true&quot;>${fallback}</div>')" />
      </div>
    `;
  }

  function renderCard(item) {
    const e = getEntry(item.id);
    const owned = e.owned === true;
    const hasDupes = e.duplicates > 0;

    const sectionClass = item.sectionId === "poster" ? "poster" : "";
    const cardClasses = ["card", owned ? "is-have" : "is-missing", hasDupes ? "has-dupes" : ""].filter(Boolean).join(" ");

    const stickerId = item.id;
    const checkboxId = `owned_${stickerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const statusLabel = hasDupes ? "Repetidas" : owned ? "Conseguido" : "Faltante";

    return `
      <article class="${cardClasses}" data-sticker-id="${escapeHtml(stickerId)}" aria-label="Cromo ${escapeHtml(
      stickerId
    )} (${escapeHtml(item.sectionLabel)}). Estado: ${statusLabel}.">
        <div class="card-top">
          <div class="sticker-id">
            ${stickerMiniMarkup(stickerId)}
            <span>${escapeHtml(stickerId)}</span>
          </div>
          <div class="section-pill ${sectionClass}">${escapeHtml(item.sectionLabel)}</div>
        </div>

        <div class="card-body">
          <div class="have-row">
            <label class="have-label" for="${checkboxId}">
              <input type="checkbox" id="${checkboxId}" data-action="toggle-owned" data-id="${escapeHtml(
      stickerId
    )}" ${owned ? "checked" : ""} />
              <span>La tengo</span>
            </label>
            <div class="state-badges" aria-hidden="true">
              <span class="state ${owned ? "have" : "missing"}">${owned ? "Conseguido" : "Faltante"}</span>
              ${hasDupes ? `<span class="state dupes">Repetidas</span>` : ""}
            </div>
          </div>

          <div class="dupes-row" aria-label="Control de repetidas">
            <div>
              <div class="dupes-title">Repetidas</div>
              <div class="help" style="margin-top:4px">Cuántas copias extra tienes</div>
            </div>
            <div class="stepper">
              <button class="mini-btn" type="button" data-action="dupe-dec" data-id="${escapeHtml(
      stickerId
    )}" aria-label="Restar repetida a ${escapeHtml(stickerId)}">−</button>
              <div class="count" aria-label="Repetidas de ${escapeHtml(stickerId)}">${e.duplicates}</div>
              <button class="mini-btn" type="button" data-action="dupe-inc" data-id="${escapeHtml(
      stickerId
    )}" aria-label="Sumar repetida a ${escapeHtml(stickerId)}">+</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderGrid() {
    const items = visibleItems();
    console.log(`Rendering stickers: ${items.length} items`);

    if (!els.grid) {
      console.error("Grid container not found: #grid");
      return;
    }

    if (items.length === 0) {
      els.grid.innerHTML = `
        <div class="empty-state" role="status" aria-live="polite">
          <div class="empty-title">No hay cromos para este filtro.</div>
          <div class="empty-meta">Cambia el filtro o busca un cromo específico.</div>
        </div>
      `;
    } else {
      try {
        els.grid.innerHTML = items.map(renderCard).join("");
      } catch (err) {
        console.error("renderGrid error", err);
        els.grid.innerHTML = `
          <div class="empty-state" role="status" aria-live="polite">
            <div class="empty-title">No se pudo renderizar el listado.</div>
            <div class="empty-meta">Revisa la consola para más detalles.</div>
          </div>
        `;
      }
    }

    if (els.visibleCountPill) els.visibleCountPill.textContent = `Mostrando ${items.length}`;
    if (els.activeFilterPill) els.activeFilterPill.textContent = `Filtro: ${filterLabel(uiState.filter)}`;
  }

  function filterLabel(filter) {
    switch (filter) {
      case "have":
        return "Tengo";
      case "missing":
        return "Me faltan";
      case "dupes":
        return "Repetidas";
      case "main":
        return "Álbum principal";
      case "poster":
        return "Póster / M";
      case "all":
      default:
        return "Todas";
    }
  }

  function renderFilters() {
    $$(".chip[data-filter]").forEach((btn) => {
      const f = btn.getAttribute("data-filter") || "all";
      const active = f === uiState.filter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.setAttribute("tabindex", active ? "0" : "-1");
    });
  }

  function render() {
    try {
      renderDashboard();
      renderFilters();
      renderGrid();
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

    // Asegura visibilidad
    uiState.filter = "all";
    saveUiState();
    render();

    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-sticker-id="${CSS.escape(id)}"]`);
      if (!card) return;
      card.classList.remove("card-highlight");
      void card.offsetWidth;
      card.classList.add("card-highlight");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      toast("🎯", "Encontrado", `Salté a ${id}.`);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.focus({ preventScroll: true });
    });
  }

  // ============================================================================
  //  Events
  // ============================================================================

  function onGridClick(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.getAttribute("data-action");
    const id = t.getAttribute("data-id");
    if (!action || !id) return;

    const cid = canonicalizeStickerId(id);
    if (!cid || !IDS.has(cid)) return;
    const cur = getEntry(cid);

    if (action === "dupe-inc") {
      setEntry(cid, { ...cur, duplicates: cur.duplicates + 1 });
      toast("🪙", "Repetida sumada", `${cid} ahora tiene ${cur.duplicates + 1}.`);
      return;
    }
    if (action === "dupe-dec") {
      const next = Math.max(0, cur.duplicates - 1);
      setEntry(cid, { ...cur, duplicates: next });
      toast("🪙", "Repetida restada", `${cid} ahora tiene ${next}.`);
      return;
    }
  }

  function onGridChange(e) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type !== "checkbox") return;
    const action = t.getAttribute("data-action");
    const id = t.getAttribute("data-id");
    if (action !== "toggle-owned" || !id) return;

    const cid = canonicalizeStickerId(id);
    if (!cid || !IDS.has(cid)) return;
    const cur = getEntry(cid);
    setEntry(cid, { ...cur, owned: t.checked });
    toast(t.checked ? "✅" : "⬜️", t.checked ? "Marcado como tengo" : "Marcado como faltante", `${cid}`);
  }

  function bindEvents() {
    // Filters
    $$(".chip[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        uiState.filter = btn.getAttribute("data-filter") || "all";
        saveUiState();
        render();
        toast("🔎", "Filtro aplicado", `Ahora: ${filterLabel(uiState.filter)}.`);
      });
    });

    // Grid
    if (!els.grid) {
      console.error("Grid container not found: #grid (cannot bind events)");
    } else {
      els.grid.addEventListener("click", onGridClick);
      els.grid.addEventListener("change", onGridChange);
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

    // Copy lists
    if (els.copyMissingBtn) {
      els.copyMissingBtn.addEventListener("click", async () => {
        const missing = buildMissingList();
        const text = `Me faltan: ${missing.join(", ") || "(ninguno)"}`;
        const ok = await copyToClipboard(text);
        toast(ok ? "📋" : "⚠️", ok ? "Copiado" : "No se pudo copiar", "Lista de faltantes.");
      });
    }
    if (els.copyDupesBtn) {
      els.copyDupesBtn.addEventListener("click", async () => {
        const dupes = buildDupesList();
        const text = `Tengo repetidas: ${dupes.join(", ") || "(ninguna)"}`;
        const ok = await copyToClipboard(text);
        toast(ok ? "📋" : "⚠️", ok ? "Copiado" : "No se pudo copiar", "Lista de repetidas.");
      });
    }

    // Export / Import
    if (els.exportBtn) els.exportBtn.addEventListener("click", exportProgress);
    if (els.importBtn && els.importFile) {
      els.importBtn.addEventListener("click", () => els.importFile.click());
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

    // Reset
    if (els.resetBtn) els.resetBtn.addEventListener("click", resetProgress);
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
