const STATUS_KEY = "np-shop-status-v1";
const CRM_KEY = "np-crm-v1";
const LAYOUT_KEY = "np-layout-mode";
const CUSTOM_SHOPS_KEY = "np-custom-shops-v1";
const CIRCUITY_FACTOR = 1.35; // urban road vs haversine (Ballou / logistics practice)
const MAPS_MAX_WAYPOINTS = 10; // Google Maps dir practical cap
const SHOPS_CACHE_BUST = "20260919v7";
const NOMINATIM_MIN_GAP_MS = 1100;

const state = {
  allShops: [],
  baseShopIds: new Set(),
  customShops: [],
  sections: [],
  center: { lat: -37.8136, lng: 144.9631 },
  selectedSection: null,
  shops: [],
  selectedIds: new Set(),
  routeUrl: null,
  routeLine: null,
  routeStops: [],
  statusMap: {},
  crm: loadCrm(),
  activeShopId: null,
  salesCategories: [],
  activeCategory: "western_premium",
  highlightId: null,
  pendingAddPlace: null,
  intelCircle: null,
  intelPlan: null,
  driverOrigin: null,
  routeChunks: [],
  _nominatimLastAt: 0,
};

const map = L.map("map").setView([-37.8136, 144.9631], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
  maxZoom: 19,
}).addTo(map);
const shopLayer = L.layerGroup().addTo(map);

function $(id) {
  return document.getElementById(id);
}

/* —— Layout modes —— */
function detectFoldDevice() {
  try {
    if (window.screen && screen.isFold) return true;
  } catch {
    /* ignore */
  }
  try {
    if (window.matchMedia("(spanning: single-fold-vertical)").matches) return true;
    if (window.matchMedia("(spanning: single-fold-horizontal)").matches) return true;
    if (window.matchMedia("(horizontal-viewport-segments: 2)").matches) return true;
    if (window.matchMedia("(vertical-viewport-segments: 2)").matches) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function resolveLayoutMode(preferred) {
  const mode = preferred || "adaptive";
  if (mode === "desktop" || mode === "mobile" || mode === "fold") return mode;
  // adaptive
  if (detectFoldDevice()) return "fold";
  const w = window.innerWidth || document.documentElement.clientWidth || 1024;
  if (w <= 820) return "mobile";
  return "desktop";
}

function applyLayoutMode(preferred) {
  const mode = ["adaptive", "desktop", "mobile", "fold"].includes(preferred)
    ? preferred
    : "adaptive";
  localStorage.setItem(LAYOUT_KEY, mode);
  const resolved = resolveLayoutMode(mode);
  document.body.setAttribute("data-layout-mode", mode);
  document.body.setAttribute("data-layout-resolved", resolved);
  document.documentElement.setAttribute("data-layout-mode", mode);
  document.documentElement.setAttribute("data-layout-resolved", resolved);
  for (const btn of document.querySelectorAll(".layout-btn")) {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-layout") === mode ? "true" : "false");
  }
  setTimeout(() => {
    try {
      map.invalidateSize();
    } catch {
      /* map may not be ready */
    }
  }, 80);
  return resolved;
}

function initLayoutSwitcher() {
  const saved = localStorage.getItem(LAYOUT_KEY) || "adaptive";
  applyLayoutMode(saved);
  document.querySelector(".layout-switcher")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".layout-btn");
    if (!btn) return;
    applyLayoutMode(btn.getAttribute("data-layout"));
  });
  window.addEventListener("resize", () => {
    clearTimeout(state._layoutResize);
    state._layoutResize = setTimeout(() => {
      const mode = localStorage.getItem(LAYOUT_KEY) || "adaptive";
      if (mode === "adaptive") applyLayoutMode("adaptive");
      else applyLayoutMode(mode);
    }, 120);
  });
  try {
    const mqs = [
      "(spanning: single-fold-vertical)",
      "(horizontal-viewport-segments: 2)",
    ];
    for (const q of mqs) {
      const mq = window.matchMedia(q);
      const handler = () => {
        if ((localStorage.getItem(LAYOUT_KEY) || "adaptive") === "adaptive") {
          applyLayoutMode("adaptive");
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", handler);
      else if (mq.addListener) mq.addListener(handler);
    }
  } catch {
    /* ignore */
  }
}

function emptyCrmRecord() {
  return {
    contactName: "",
    contactRole: "",
    phone: "",
    email: "",
    businessNotes: "",
    visitDate: "",
    outcome: "",
    visitLog: [],
    status: "prospect",
    updatedAt: null,
  };
}

function loadCrm() {
  let crm = { version: 1, shops: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(CRM_KEY) || "null");
    if (raw && raw.shops) crm = { version: 1, shops: raw.shops };
  } catch {
    /* ignore */
  }
  // migrate legacy status map
  try {
    const legacy = JSON.parse(localStorage.getItem(STATUS_KEY) || "{}");
    for (const [id, status] of Object.entries(legacy)) {
      if (!crm.shops[id]) crm.shops[id] = emptyCrmRecord();
      if (!crm.shops[id].status || crm.shops[id].status === "prospect") {
        crm.shops[id].status = status;
      }
    }
  } catch {
    /* ignore */
  }
  return crm;
}

function saveCrm() {
  localStorage.setItem(CRM_KEY, JSON.stringify(state.crm));
  // keep status mirror for older filters
  const statusMirror = {};
  for (const [id, rec] of Object.entries(state.crm.shops)) {
    if (rec.status) statusMirror[id] = rec.status;
  }
  localStorage.setItem(STATUS_KEY, JSON.stringify(statusMirror));
  state.statusMap = statusMirror;
}

function getCrm(shopId) {
  if (!state.crm.shops[shopId]) state.crm.shops[shopId] = emptyCrmRecord();
  return state.crm.shops[shopId];
}

function shopStatus(shop) {
  const rec = state.crm.shops[shop.id];
  return (rec && rec.status) || shop.status || "prospect";
}

function melbourneDateISO(d = new Date()) {
  // en-CA → YYYY-MM-DD in Australia/Melbourne local calendar
  try {
    return d.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
  } catch {
    return d.toLocaleDateString("en-CA");
  }
}

function mapsSearchUrl(query, lat, lng, zoom = 13) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat},${lng},${zoom}z`;
}

function mapsDirUrl(coords) {
  const chunks = mapsDirChunks(coords);
  return chunks[0] || "";
}

function mapsDirChunks(coords) {
  if (!coords.length) return [];
  // Google Maps /dir/ is unreliable beyond ~10 waypoints — chunk routes
  const max = MAPS_MAX_WAYPOINTS;
  const chunks = [];
  for (let i = 0; i < coords.length; i += max - 1) {
    // overlap last point of previous chunk as start of next for continuity
    const slice = coords.slice(i, i + max);
    if (slice.length < 2 && chunks.length) break;
    if (slice.length < 1) break;
    chunks.push(
      "https://www.google.com/maps/dir/" + slice.map(([lat, lng]) => `${lat},${lng}`).join("/")
    );
    if (i + max >= coords.length) break;
  }
  return chunks;
}

function renderMapsChunkButtons(coords) {
  const box = $("routeMapsChunks");
  if (!box) return;
  const chunks = mapsDirChunks(coords);
  state.routeChunks = chunks;
  if (chunks.length <= 1) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  // Part labels only (avoid double-assigning complex stop-range HTML)
  box.innerHTML = chunks
    .map(
      (url, i) =>
        `<button type="button" class="btn accent" data-maps-chunk="${i}">Open Maps part ${i + 1}/${chunks.length}</button>`
    )
    .join("");
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function pathLength(coords) {
  let n = 0;
  for (let i = 0; i < coords.length - 1; i++) n += haversineKm(coords[i], coords[i + 1]) * CIRCUITY_FACTOR;
  return n;
}

function optimizeOrder(shops, startCoord = null) {
  const usable = shops.filter((s) => s.lat != null && s.lng != null);
  if (!usable.length) return { shops: [], distanceKm: 0, coords: [] };
  const coords = usable.map((s) => [s.lat, s.lng]);
  const unvisited = new Set(usable.map((_, i) => i));
  // Start from driver origin (nearest shop) when provided — not arbitrary index 0
  let startIdx = 0;
  if (startCoord && startCoord.lat != null && startCoord.lng != null) {
    let bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = haversineKm([startCoord.lat, startCoord.lng], coords[i]);
      if (d < bestD) {
        bestD = d;
        startIdx = i;
      }
    }
  }
  const order = [startIdx];
  unvisited.delete(startIdx);
  while (unvisited.size) {
    const last = order[order.length - 1];
    let best = null;
    let bestD = Infinity;
    for (const i of unvisited) {
      const d = haversineKm(coords[last], coords[i]) * CIRCUITY_FACTOR;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    unvisited.delete(best);
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++) {
      for (let j = i + 1; j < order.length; j++) {
        if (j - i === 1) continue;
        const next = order.slice(0, i).concat(order.slice(i, j).reverse(), order.slice(j));
        if (pathLength(next.map((k) => coords[k])) < pathLength(order.map((k) => coords[k]))) {
          order.splice(0, order.length, ...next);
          improved = true;
        }
      }
    }
  }
  const ordered = order.map((i) => usable[i]);
  const path = order.map((i) => coords[i]);
  return { shops: ordered, distanceKm: Math.round(pathLength(path) * 100) / 100, coords: path };
}

function shopsInActiveCategory() {
  return state.allShops.filter(
    (s) => (s.sales_category || "other") === (state.activeCategory || "western_premium")
  );
}

function enrichSections(raw) {
  const counts = {};
  for (const s of shopsInActiveCategory()) {
    counts[s.section_id] = (counts[s.section_id] || 0) + 1;
  }
  return (raw.sections || []).map((sec) => {
    const [s, w, n, e] = sec.bbox;
    const center = { lat: (s + n) / 2, lng: (w + e) / 2 };
    const q0 = (sec.search_queries || ["gourmet organic spice store"])[0];
    return {
      ...sec,
      shop_count: counts[sec.id] || 0,
      center,
      google_maps_url: mapsSearchUrl(`${q0} ${sec.name} Melbourne`, center.lat, center.lng),
      suburb_maps: (sec.suburbs || []).map((sub) => ({
        suburb: sub.name,
        postcode: sub.postcode,
        url: mapsSearchUrl(
          `organic gourmet spice food store ${sub.name} VIC ${sub.postcode}`,
          center.lat,
          center.lng,
          14
        ),
      })),
    };
  });
}

function refreshSectionsForCategory() {
  const raw = state._sectionsRaw || { sections: state.sections };
  const keepId = state.selectedSection?.id;
  state.sections = enrichSections(raw);
  state.selectedSection =
    state.sections.find((s) => s.id === keepId) || state.sections[0] || null;
  renderSections();
}

function fitToVisibleShops() {
  const pts = state.shops.filter((s) => s.lat != null && s.lng != null);
  if (pts.length >= 2) {
    map.fitBounds(
      pts.map((s) => [s.lat, s.lng]),
      { padding: [40, 40], maxZoom: 13 }
    );
  } else if (pts.length === 1) {
    map.setView([pts[0].lat, pts[0].lng], 13);
  } else if (state.selectedSection) {
    fitSection(state.selectedSection);
  }
}

function priorityTag(p) {
  if (p === "high") return '<span class="tag warn">high priority</span>';
  return `<span class="tag">${p || "medium"}</span>`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSuburbs(section) {
  const box = $("suburbList");
  if (!section) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = (section.suburb_maps || [])
    .map(
      (s) =>
        `<a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.suburb)} <span>${escapeHtml(s.postcode)}</span></a>`
    )
    .join("");
}

function renderSections() {
  const sel = $("sectionSelect");
  sel.innerHTML = state.sections
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${s.shop_count || 0})</option>`)
    .join("");
  if (state.selectedSection) sel.value = state.selectedSection.id;
}

function fitSection(section) {
  if (!section) return;
  const [s, w, n, e] = section.bbox;
  map.fitBounds([
    [s, w],
    [n, e],
  ]);
}

function markerColor(status) {
  switch (status) {
    case "planned":
      return "#c45c26";
    case "visited":
      return "#2f6b4f";
    case "customer":
      return "#1f4a37";
    case "skip":
      return "#9aa39c";
    default:
      return "#3d6e9c";
  }
}

const CATEGORY_COLORS = {
  western_premium: "#1f5c3a",
  indian: "#a67c2a",
  asian: "#c45c26",
  health_chains: "#5b6b8c",
  other: "#8a958c",
};

function salesCategoryColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
}

function renderCategoryTabs() {
  const box = $("categoryTabs");
  if (!box) return;
  const cats = state.salesCategories.length
    ? state.salesCategories
    : [
        { id: "western_premium", label: "Western premium / independent" },
        { id: "indian", label: "Indian grocery & spices" },
        { id: "asian", label: "Asian grocery" },
        { id: "health_chains", label: "Health / vitamin chains" },
        { id: "other", label: "Uncategorised / other" },
      ];
  const counts = {};
  for (const s of state.allShops) {
    const c = s.sales_category || "other";
    counts[c] = (counts[c] || 0) + 1;
  }
  box.innerHTML = cats
    .map((c) => {
      const n = counts[c.id] || 0;
      const short =
        c.id === "western_premium"
          ? "Western premium"
          : c.id === "indian"
            ? "Indian"
            : c.id === "asian"
              ? "Asian"
              : c.id === "health_chains"
                ? "Chains"
                : "Other";
      const pressed = state.activeCategory === c.id ? "true" : "false";
      return `<button type="button" class="cat-tab" data-category="${c.id}" aria-pressed="${pressed}" style="--cat:${salesCategoryColor(c.id)}">${short} <span>${n}</span></button>`;
    })
    .join("");
  const hint = $("categoryHint");
  if (hint) {
    const labels = Object.fromEntries(cats.map((c) => [c.id, c.label]));
    hint.textContent =
      state.activeCategory === "western_premium"
        ? "Priority buyers: independent Western premium food stores."
        : `Showing: ${labels[state.activeCategory] || state.activeCategory}.`;
  }
}


function crmBadge(shopId) {
  const rec = state.crm.shops[shopId];
  if (!rec) return "";
  const has =
    rec.contactName ||
    rec.phone ||
    rec.email ||
    rec.businessNotes ||
    (rec.visitLog && rec.visitLog.length);
  return has ? '<span class="tag">CRM</span>' : "";
}

function renderMap() {
  shopLayer.clearLayers();
  const stopIndex = {};
  state.routeStops.forEach((s, i) => {
    stopIndex[s.id] = i + 1;
  });
  for (const shop of state.shops) {
    if (shop.lat == null || shop.lng == null) continue;
    const n = stopIndex[shop.id];
    const catColor = salesCategoryColor(shop.sales_category || "other");
    const score = leadScore(shop);
    const marker = L.circleMarker([shop.lat, shop.lng], {
      radius: shop.id === state.highlightId ? 12 : n ? 10 : state.selectedIds.has(shop.id) ? 9 : 7,
      color: shop.id === state.highlightId ? "#a67c2a" : "#fff",
      weight: shop.id === state.highlightId ? 3 : 2,
      fillColor: n ? "#a67c2a" : catColor,
      fillOpacity: 0.9,
    });
    const title = n ? `Stop ${n}: ${shop.name}` : shop.name;
    marker.bindPopup(
      `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(shop.address || "")}<br>` +
        `<span class="lead-score ${leadScoreClass(score)}">Lead ${score}</span><br>` +
        `<em>${escapeHtml(shop.sales_category_label || shop.category || "")}</em><br>` +
        `<button type="button" class="popup-crm-btn" data-open-crm="${shop.id}">Open CRM</button>` +
        ` <button type="button" class="popup-crm-btn" data-select-shop="${shop.id}" style="background:#c45c26">Select</button>`
    );
    // Click opens popup only — exploration first (no forced CRM / route-select)
    marker.on("popupopen", () => {
      const el = marker.getPopup()?.getElement();
      if (!el) return;
      el.querySelector("[data-open-crm]")?.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          openCrm(shop.id, { fromMap: false });
        },
        { once: true }
      );
      el.querySelector("[data-select-shop]")?.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          state.selectedIds.add(shop.id);
          updateSelectHint();
          renderList();
          renderMap();
        },
        { once: true }
      );
    });
    marker.addTo(shopLayer);
    if (shop.id === state.highlightId) marker.openPopup();
  }
}

function renderRouteStops() {
  const box = $("routeStops");
  if (!state.routeStops.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = state.routeStops
    .map((s, i) => {
      const addr = s.address || `${s.suburb || ""} ${s.postcode || ""}`.trim();
      return `<li>
        <button type="button" class="route-stop-btn" data-open-crm="${s.id}">
          <span class="stop-num">${i + 1}</span>
          <span class="stop-body">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="meta">${escapeHtml(addr || "Address TBD")}</span>
          </span>
        </button>
      </li>`;
    })
    .join("");
}

function renderList() {
  const list = $("shopList");
  const stopIndex = {};
  state.routeStops.forEach((s, i) => {
    stopIndex[s.id] = i + 1;
  });
  $("listCount").textContent = `${state.shops.length} shops`;
  $("listTitle").textContent = state.routeStops.length
    ? `Today’s route (${state.routeStops.length})`
    : state.selectedSection?.name || "All sections";
  if (!state.shops.length) {
    list.innerHTML = `<div class="empty-state">No shops in this category + section. Try another section or category.</div>`;
    return;
  }
  list.innerHTML = state.shops
    .map((shop) => {
      const st = shopStatus(shop);
      const checked = state.selectedIds.has(shop.id) ? "checked" : "";
      const selected = state.selectedIds.has(shop.id) ? "selected" : "";
      const stop = stopIndex[shop.id];
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${shop.name} ${shop.address || ""} Melbourne`
      )}`;
      return `
      <article class="shop-card ${selected}" data-id="${shop.id}">
        <input type="checkbox" ${checked} data-select="${shop.id}" aria-label="Select ${escapeHtml(shop.name)}" />
        <div>
          <h3>${stop ? `<span class="stop-chip">${stop}</span> ` : ""}${escapeHtml(shop.name)}</h3>
          <div class="meta">${escapeHtml(shop.address || "Address TBD")}</div>
          <div class="meta">${escapeHtml(shop.suburb || "")} ${escapeHtml(shop.postcode || "")}</div>
          <div class="tags">
            ${priorityTag(shop.priority)}
            <span class="tag cat-pill" style="--cat:${salesCategoryColor(shop.sales_category || "other")}">${escapeHtml(shop.sales_category_label || shop.sales_category || "other")}</span>
            <span class="tag">${escapeHtml(st)}</span>
            ${crmBadge(shop.id)}
        <span class="lead-score ${leadScoreClass(leadScore(shop))}" title="Lead score">Lead ${leadScore(shop)}</span>
          </div>
          <div class="actions">
            <button type="button" data-open-crm="${shop.id}">CRM / notes</button>
            <a href="${maps}" target="_blank" rel="noopener">Maps</a>
            <button type="button" data-status="planned" data-id="${shop.id}">Plan</button>
            <button type="button" data-status="visited" data-id="${shop.id}">Visited</button>
            <button type="button" data-status="customer" data-id="${shop.id}">Customer</button>
            <button type="button" data-status="skip" data-id="${shop.id}">Skip</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

function updateSelectHint() {
  const hint = $("selectHint");
  if (!hint) return;
  const n = state.selectedIds.size;
  hint.textContent = n
    ? `${n} shop${n === 1 ? "" : "s"} selected — tap Best route, then Open route in Google Maps.`
    : "Tick shops below (or on the map).";
}

function updateStatusLine() {
  const crmCount = Object.values(state.crm.shops).filter(
    (r) => r.contactName || r.phone || r.businessNotes || (r.visitLog && r.visitLog.length)
  ).length;
  const inCat = state.allShops.filter((s) => (s.sales_category || "other") === state.activeCategory).length;
  const customN = state.customShops.length;
  const customBit = customN ? ` · ${customN} custom` : "";
  $("statusLine").textContent = `${state.allShops.length} shops · ${inCat} in this category · ${crmCount} with CRM${customBit}`;
}

function toggleSelect(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  updateSelectHint();
  renderList();
  renderMap();
}

function applyFilters() {
  const sectionId = state.selectedSection?.id || "";
  const q = ($("searchBox").value || "").trim().toLowerCase();
  const status = $("statusFilter").value;
  const scopeToFilters = Boolean($("findInFilters")?.checked);
  // Default: name search is global (all categories + sections). Optional checkbox keeps filters.
  const globalFind = Boolean(q) && !scopeToFilters;
  state.shops = state.allShops.filter((s) => {
    if (!globalFind) {
      if (state.activeCategory && (s.sales_category || "other") !== state.activeCategory) return false;
      if (sectionId && s.section_id !== sectionId) return false;
    }
    if (status && shopStatus(s) !== status) return false;
    if (q) {
      const crm = state.crm.shops[s.id] || {};
      const hay = `${s.name} ${s.address || ""} ${s.suburb || ""} ${s.postcode || ""} ${s.category || ""} ${s.notes || ""} ${s.sales_category_label || ""} ${crm.contactName || ""} ${crm.phone || ""} ${crm.businessNotes || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (state.routeStops.length && !q && !status) {
    const ids = new Set(state.shops.map((s) => s.id));
    const ordered = state.routeStops.filter((s) => ids.has(s.id));
    const rest = state.shops.filter((s) => !state.routeStops.some((r) => r.id === s.id));
    if (ordered.length) state.shops = ordered.concat(rest);
  } else if (!state.routeStops.length) {
    state.shops = sortShopsForDisplay(state.shops);
  }
  renderList();
  renderMap();
  renderRouteStops();
  updateStatusLine();
}

function setStatus(id, status, { openCrmOnVisited = true } = {}) {
  const rec = getCrm(id);
  rec.status = status;
  rec.updatedAt = new Date().toISOString();
  if (status === "visited" && !rec.visitDate) {
    rec.visitDate = melbourneDateISO();
  }
  saveCrm();
  applyFilters();
  updateStatusLine();
  if (state.activeShopId === id) fillCrmForm(id);
  if (openCrmOnVisited && status === "visited") openCrm(id, { focusNotes: true });
}

function buildRoute() {
  const ids = [...state.selectedIds];
  if (!ids.length) {
    alert("Select at least one shop first.");
    return;
  }
  const picked = state.allShops.filter((s) => ids.includes(s.id));
  if (picked.length > MAPS_MAX_WAYPOINTS) {
    const ok = confirm(
      `You selected ${picked.length} shops. Google Maps works best with ≤${MAPS_MAX_WAYPOINTS} stops.\n\nOK = optimize all and open in map parts.\nCancel = trim to top ${MAPS_MAX_WAYPOINTS} by lead score first.`
    );
    if (!ok) {
      picked.sort((a, b) => leadScore(b) - leadScore(a));
      picked.length = MAPS_MAX_WAYPOINTS;
      state.selectedIds = new Set(picked.map((s) => s.id));
      updateSelectHint();
    }
  }
  const start = state.driverOrigin;
  const result = optimizeOrder(picked, start);
  let coords = result.coords;
  if (start && start.lat != null) {
    coords = [[start.lat, start.lng], ...result.coords];
  }
  state.routeStops = result.shops;
  state.routeUrl = mapsDirUrl(coords);
  $("btnOpenRoute").disabled = !state.routeUrl;
  if (state._syncSticky) state._syncSticky();
  const chunkN = mapsDirChunks(coords).length;
  $("routeSummary").textContent =
    `Ready: ${result.shops.length} stops · ~${result.distanceKm} km` +
    (chunkN > 1 ? ` · open Maps in ${chunkN} parts` : "");
  renderMapsChunkButtons(coords);
  if (state.routeLine) map.removeLayer(state.routeLine);
  if (coords.length) {
    state.routeLine = L.polyline(coords, {
      color: "#c45c26",
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    map.fitBounds(state.routeLine.getBounds(), { padding: [30, 30] });
  }
  state.shops = result.shops;
  renderList();
  renderMap();
  renderRouteStops();
}

function clearRouteUi() {
  state.routeStops = [];
  state.routeUrl = null;
  state.routeChunks = [];
  $("btnOpenRoute").disabled = true;
  if (state._syncSticky) state._syncSticky();
  $("routeSummary").textContent = "";
  const box = $("routeMapsChunks");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  renderRouteStops();
  if (state.routeLine) {
    map.removeLayer(state.routeLine);
    state.routeLine = null;
  }
}

function fillCrmForm(shopId) {
  const shop = state.allShops.find((s) => s.id === shopId);
  if (!shop) return;
  const rec = getCrm(shopId);
  $("crmShopName").textContent = shop.name;
  $("crmShopMeta").textContent = `${shop.address || ""} · ${shop.suburb || ""} ${shop.postcode || ""}`.trim();
  $("crmContactName").value = rec.contactName || "";
  $("crmContactRole").value = rec.contactRole || "";
  $("crmPhone").value = rec.phone || "";
  $("crmEmail").value = rec.email || "";
  $("crmVisitDate").value = rec.visitDate || "";
  $("crmOutcome").value = rec.outcome || "";
  $("crmBusinessNotes").value = rec.businessNotes || "";
  $("crmLogEntry").value = "";
  $("crmMapsLink").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${shop.name} ${shop.address || ""} Melbourne`
  )}`;
  const log = $("crmVisitLog");
  const entries = [...(rec.visitLog || [])].reverse();
  log.innerHTML = entries.length
    ? entries
        .map(
          (e) =>
            `<li><time>${escapeHtml((e.at || "").slice(0, 16).replace("T", " "))}</time>${
              e.outcome ? ` · <em>${escapeHtml(e.outcome)}</em>` : ""
            }<div>${escapeHtml(e.text)}</div></li>`
        )
        .join("")
    : "<li class='empty'>No visit notes yet.</li>";
  for (const btn of $("crmStatusRow").querySelectorAll("button")) {
    btn.classList.toggle("active", btn.getAttribute("data-crm-status") === shopStatus(shop));
  }
}

function openCrm(shopId, { focusNotes = false, fromMap = false } = {}) {
  state.activeShopId = shopId;
  fillCrmForm(shopId);
  const drawer = $("crmDrawer");
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("crm-open");
  const del = $("btnDeleteCustom");
  if (del) {
    const shop = state.allShops.find((s) => s.id === shopId);
    del.hidden = !(shop && shop.custom);
  }
  renderList();
  // Avoid map flicker while CRM is open — list highlight is enough
  if (!fromMap) {
    /* keep map as-is */
  }
  setTimeout(() => {
    if (focusNotes) $("crmLogEntry").focus();
    else $("crmContactName").focus();
  }, 50);
}

function deleteCustomShop() {
  const id = state.activeShopId;
  if (!id) return;
  const shop = state.allShops.find((s) => s.id === id);
  if (!shop || !shop.custom) {
    alert("Only custom (added) shops can be removed.");
    return;
  }
  if (!confirm(`Remove “${shop.name}” from your list?`)) return;
  state.customShops = state.customShops.filter((s) => s.id !== id);
  saveCustomShops();
  delete state.crm.shops[id];
  saveCrm();
  state.selectedIds.delete(id);
  state.routeStops = state.routeStops.filter((s) => s.id !== id);
  if (state.highlightId === id) state.highlightId = null;
  rebuildAllShops();
  closeCrm();
  refreshSectionsForCategory();
  applyFilters();
  updateStatusLine();
}

function closeCrm() {
  $("crmDrawer").hidden = true;
  $("crmDrawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("crm-open");
  state.activeShopId = null;
}

function saveCrmForm(ev) {
  ev.preventDefault();
  const id = state.activeShopId;
  if (!id) return;
  const rec = getCrm(id);
  rec.contactName = $("crmContactName").value.trim();
  rec.contactRole = $("crmContactRole").value.trim();
  rec.phone = $("crmPhone").value.trim();
  rec.email = $("crmEmail").value.trim();
  rec.visitDate = $("crmVisitDate").value;
  rec.outcome = $("crmOutcome").value;
  rec.businessNotes = $("crmBusinessNotes").value.trim();
  const logText = $("crmLogEntry").value.trim();
  if (logText) {
    rec.visitLog = rec.visitLog || [];
    rec.visitLog.push({
      at: new Date().toISOString(),
      text: logText,
      outcome: rec.outcome || "",
    });
  }
  rec.updatedAt = new Date().toISOString();
  saveCrm();
  fillCrmForm(id);
  applyFilters();
  updateStatusLine();
  $("crmLogEntry").value = "";
}

function downloadBlob(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCrmJson() {
  const payload = {
    version: 2,
    exported_at: new Date().toISOString(),
    shops: state.crm.shops,
    custom_shops: state.customShops,
  };
  downloadBlob(
    `natures-pinch-crm-${melbourneDateISO()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
}

function exportCrmCsv() {
  const fields = [
    "shop_id",
    "shop_name",
    "address",
    "suburb",
    "postcode",
    "status",
    "contactName",
    "contactRole",
    "phone",
    "email",
    "visitDate",
    "outcome",
    "businessNotes",
    "visitLogCount",
    "updatedAt",
  ];
  const byId = Object.fromEntries(state.allShops.map((s) => [s.id, s]));
  const lines = [fields.join(",")];
  for (const [id, rec] of Object.entries(state.crm.shops)) {
    const shop = byId[id] || {};
    const row = [
      id,
      shop.name || "",
      shop.address || "",
      shop.suburb || "",
      shop.postcode || "",
      rec.status || "",
      rec.contactName || "",
      rec.contactRole || "",
      rec.phone || "",
      rec.email || "",
      rec.visitDate || "",
      rec.outcome || "",
      rec.businessNotes || "",
      (rec.visitLog || []).length,
      rec.updatedAt || "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  downloadBlob(
    `natures-pinch-crm-${melbourneDateISO()}.csv`,
    lines.join("\n") + "\n",
    "text/csv"
  );
}


function sanitizeCrmText(v, max = 4000) {
  return String(v == null ? "" : v)
    .replace(/[<>]/g, "")
    .slice(0, max);
}

function importCrmJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = data.shops || data;
      if (!incoming || typeof incoming !== "object") throw new Error("No shops object");
      let n = 0;
      for (const [id, rec] of Object.entries(incoming)) {
        if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(String(id))) continue;
        const base = getCrm(id);
        const cleanLog = Array.isArray(rec.visitLog)
          ? rec.visitLog.slice(0, 200).map((e) => ({
              at: sanitizeCrmText(e?.at, 40),
              text: sanitizeCrmText(e?.text, 2000),
              outcome: sanitizeCrmText(e?.outcome, 120),
            }))
          : base.visitLog || [];
        state.crm.shops[id] = {
          ...emptyCrmRecord(),
          ...base,
          contactName: sanitizeCrmText(rec.contactName ?? base.contactName, 200),
          contactRole: sanitizeCrmText(rec.contactRole ?? base.contactRole, 120),
          phone: sanitizeCrmText(rec.phone ?? base.phone, 60),
          email: sanitizeCrmText(rec.email ?? base.email, 120),
          businessNotes: sanitizeCrmText(rec.businessNotes ?? base.businessNotes, 4000),
          visitDate: sanitizeCrmText(rec.visitDate ?? base.visitDate, 20),
          outcome: sanitizeCrmText(rec.outcome ?? base.outcome, 120),
          status: sanitizeCrmText(rec.status ?? base.status, 40) || "prospect",
          visitLog: cleanLog,
          updatedAt: sanitizeCrmText(rec.updatedAt || new Date().toISOString(), 40),
        };
        n += 1;
      }
      if (Array.isArray(data.custom_shops) && data.custom_shops.length) {
        const byId = Object.fromEntries(state.customShops.map((s) => [s.id, s]));
        for (const shop of data.custom_shops) {
          if (!shop || !shop.id) continue;
          byId[shop.id] = { ...byId[shop.id], ...shop, custom: true };
        }
        state.customShops = Object.values(byId);
        saveCustomShops();
        rebuildAllShops();
      }
      saveCrm();
      applyFilters();
      updateStatusLine();
      alert(`Imported CRM for ${n} shops.`);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function downloadMarkdown() {
  const lines = [
    "# Nature's Pinch shops",
    "",
    `Section: ${state.selectedSection?.name || "all"}`,
    `Count: ${state.shops.length}`,
    "",
    "| Name | Suburb | Postcode | Category | Priority | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of state.shops) {
    lines.push(
      `| ${(s.name || "").replace(/\|/g, "/")} | ${(s.suburb || "").replace(/\|/g, "/")} | ${s.postcode || ""} | ${(s.category || "").replace(/\|/g, "/")} | ${s.priority || ""} | ${shopStatus(s)} |`
    );
  }
  downloadBlob(
    `natures-pinch-${state.selectedSection?.id || "all"}.md`,
    lines.join("\n") + "\n",
    "text/markdown"
  );
}

/* —— Plan by time (v4) —— */
const URBAN_SPEED_KMH = 32; // Melbourne urban estimate
const NOMINATIM_UA = null; // browsers forbid User-Agent header — do not set

function parseLatLng(text) {
  const m = String(text || "")
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
}

function driveMinutesHaversine(a, b) {
  const km = haversineKm([a.lat, a.lng], [b.lat, b.lng]) * CIRCUITY_FACTOR;
  return (km / URBAN_SPEED_KMH) * 60;
}

async function osrmDurationMatrix(points) {
  // points: [{lat,lng}, ...] — OSRM wants lon,lat
  if (points.length < 2) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.durations) return null;
    return data.durations; // seconds matrix
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function minutesFromMatrix(matrix, i, j, fallbackA, fallbackB) {
  if (matrix && matrix[i] && matrix[i][j] != null && Number.isFinite(matrix[i][j])) {
    return Math.max(0, matrix[i][j] / 60);
  }
  return driveMinutesHaversine(fallbackA, fallbackB);
}

async function geocodeOrigin(raw) {
  const pasted = parseLatLng(raw);
  if (pasted) return pasted;
  const q = String(raw || "").trim();
  if (!q) throw new Error("Enter your current address or paste lat,lng.");
  const query = /melbourne|vic|australia/i.test(q) ? q : `${q}, Melbourne VIC, Australia`;
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      countrycodes: "au",
    });
  const res = await nominatimFetch(url);
  if (!res.ok) throw new Error("Address lookup failed. Try pasting lat,lng.");
  const rows = await res.json();
  if (!rows.length) throw new Error("Address not found. Try a clearer address or lat,lng.");
  return {
    lat: parseFloat(rows[0].lat),
    lng: parseFloat(rows[0].lon),
    label: rows[0].display_name || query,
  };
}

function leadScore(shop, origin = null) {
  // B2B field-sales style A/B/C: category + CRM stage + readiness − distance
  const catW = {
    western_premium: 42,
    indian: 32,
    asian: 24,
    health_chains: 12,
    other: 6,
  };
  let score = catW[shop.sales_category || "other"] || 6;
  if (shop.priority === "high") score += 22;
  else if (shop.priority === "medium") score += 8;
  const st = shopStatus(shop);
  const statusW = {
    customer: 28,
    prospect: 18,
    planned: 16,
    visited: 8,
    skip: -45,
  };
  score += statusW[st] ?? 10;
  const crm = state.crm.shops[shop.id] || {};
  if (crm.contactName || crm.phone || crm.email) score += 10;
  if (crm.businessNotes && String(crm.businessNotes).length > 20) score += 6;
  if (crm.visitLog && crm.visitLog.length) score += 4;
  if (crm.outcome && /interest|sample|order|yes|positive|follow/i.test(crm.outcome)) score += 12;
  if (crm.visitDate) {
    // slight boost if follow-up overdue (>21 days since visit)
    const days = (Date.now() - new Date(crm.visitDate).getTime()) / 86400000;
    if (Number.isFinite(days) && days > 21 && st !== "skip") score += 8;
  }
  if (shop.custom) score += 5;
  const o = origin || state.driverOrigin;
  if (o && shop.lat != null && shop.lng != null) {
    const km = haversineKm([o.lat, o.lng], [shop.lat, shop.lng]);
    score -= Math.min(28, km * 1.8);
  }
  return Math.round(score);
}

function leadScoreClass(score) {
  if (score >= 70) return "hot";
  if (score < 25) return "low";
  return "";
}

function sortShopsForDisplay(list) {
  const mode = $("leadSort")?.value || "score";
  const arr = [...list];
  if (mode === "name") {
    arr.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  } else if (mode === "distance") {
    if (state.driverOrigin) {
      const o = state.driverOrigin;
      arr.sort(
        (a, b) =>
          haversineKm([o.lat, o.lng], [a.lat, a.lng]) -
          haversineKm([o.lat, o.lng], [b.lat, b.lng])
      );
    } else {
      const hint = $("statusLine");
      if (hint && !state._distSortHinted) {
        state._distSortHinted = true;
        const prev = hint.textContent;
        hint.textContent = "Nearest sort needs a start address — run Optimize leads / Plan by time first.";
        setTimeout(() => {
          state._distSortHinted = false;
          updateStatusLine();
        }, 3500);
        void prev;
      }
      arr.sort((a, b) => leadScore(b) - leadScore(a));
    }
  } else if (mode === "section") {
    /* keep filter order */
  } else {
    // best leads first
    arr.sort((a, b) => leadScore(b) - leadScore(a));
  }
  return arr;
}

async function nominatimFetch(url) {
  const now = Date.now();
  const wait = NOMINATIM_MIN_GAP_MS - (now - (state._nominatimLastAt || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state._nominatimLastAt = Date.now();
  let attempt = 0;
  while (attempt < 3) {
    attempt += 1;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    return res;
  }
  throw new Error("Nominatim rate-limited. Wait a moment and try again.");
}

function formatMinutes(m) {
  const mins = Math.round(m);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function clearTimePlanUi() {
  const sum = $("timePlanSummary");
  const box = $("timePlanStops");
  if (sum) sum.innerHTML = "";
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  state.timePlan = null;
}

async function planByTime() {
  const hours = parseFloat($("timeBudgetHours")?.value || "3");
  const visitMins = parseFloat($("timeVisitMins")?.value || "30");
  const originRaw = $("timeOrigin")?.value || "";
  const summary = $("timePlanSummary");
  const stopsBox = $("timePlanStops");
  if (!Number.isFinite(hours) || hours <= 0) {
    alert("Enter available time in hours (e.g. 3).");
    return;
  }
  if (!Number.isFinite(visitMins) || visitMins < 5) {
    alert("Visit minutes must be at least 5.");
    return;
  }
  const budget = hours * 60;
  const btn = $("btnPlanByTime");
  if (btn) btn.disabled = true;
  if (summary) summary.textContent = "Looking up your location…";
  if (stopsBox) {
    stopsBox.hidden = true;
    stopsBox.innerHTML = "";
  }

  try {
    const origin = await geocodeOrigin(originRaw);
    state.driverOrigin = origin;
    // Plan-by-time uses active category across ALL sections (not trapped in one map section)
    let candidates = state.allShops.filter((s) => {
      if (s.lat == null || s.lng == null) return false;
      return (s.sales_category || "other") === (state.activeCategory || "western_premium");
    });
    if (!candidates.length) {
      summary.textContent =
        "No shops in this category. Switch category tab, then try again.";
      return;
    }

    // Cap: keep nearest 40 by haversine from origin, prefer high lead scores on ties
    if (candidates.length > 40) {
      candidates = [...candidates]
        .sort((a, b) => {
          const da = haversineKm([origin.lat, origin.lng], [a.lat, a.lng]);
          const db = haversineKm([origin.lat, origin.lng], [b.lat, b.lng]);
          if (Math.abs(da - db) < 0.4) return leadScore(b, origin) - leadScore(a, origin);
          return da - db;
        })
        .slice(0, 40);
    }

    if (summary) summary.textContent = "Estimating drive times…";
    // Index 0 = origin, 1..n = shops (for optional OSRM matrix)
    const points = [origin, ...candidates.map((s) => ({ lat: s.lat, lng: s.lng }))];
    const matrix = await osrmDurationMatrix(points);
    const estimateLabel = matrix ? "OSRM drive" : `haversine @ ~${URBAN_SPEED_KMH} km/h`;

    // Greedy NN + priority: maximise shops under budget
    const remainingIdx = new Set(candidates.map((_, i) => i));
    const route = [];
    let used = 0;
    let curLat = origin.lat;
    let curLng = origin.lng;
    let curMatrixIdx = 0;

    while (remainingIdx.size) {
      let best = null;
      for (const i of remainingIdx) {
        const shop = candidates[i];
        const shopMatrixIdx = i + 1;
        const drive = minutesFromMatrix(
          matrix,
          curMatrixIdx,
          shopMatrixIdx,
          { lat: curLat, lng: curLng },
          shop
        );
        const cost = drive + visitMins;
        if (used + cost > budget + 0.05) continue;
        const value = Math.max(1, leadScore(shop, origin));
        const score = value / Math.max(8, cost);
        if (!best || score > best.score) {
          best = { i, shop, drive, cost, score, shopMatrixIdx };
        }
      }
      if (!best) break;
      route.push({
        shop: best.shop,
        driveMins: best.drive,
        visitMins,
      });
      used += best.cost;
      remainingIdx.delete(best.i);
      curLat = best.shop.lat;
      curLng = best.shop.lng;
      curMatrixIdx = best.shopMatrixIdx;
    }

    const placeLabel = (origin.label || "").split(",")[0] || "your location";
    if (!route.length) {
      summary.innerHTML = `With <strong>${formatMinutes(budget)}</strong> from <em>${escapeHtml(
        placeLabel
      )}</em> you cannot cover a full shop visit (${visitMins}m) plus drive in this filter. Try a longer budget or another section.`;
      return;
    }

    const driveTotal = route.reduce((n, r) => n + r.driveMins, 0);
    const visitTotal = route.length * visitMins;
    const total = driveTotal + visitTotal;
    const coords = [[origin.lat, origin.lng], ...route.map((r) => [r.shop.lat, r.shop.lng])];
    const mapsUrl = mapsDirUrl(coords);

    // Sync into main route UI so Open Maps / list stay consistent
    state.selectedIds = new Set(route.map((r) => r.shop.id));
    state.routeStops = route.map((r) => r.shop);
    state.routeUrl = mapsUrl;
    state.timePlan = { origin, route, budget, visitMins, estimateLabel, mapsUrl };
    $("btnOpenRoute").disabled = !mapsUrl;
    if (state._syncSticky) state._syncSticky();
    renderMapsChunkButtons(coords);
    $("routeSummary").textContent = `Time plan: ${route.length} stops · ~${formatMinutes(total)} (est.)`;
    if (state.routeLine) map.removeLayer(state.routeLine);
    state.routeLine = L.polyline(coords, {
      color: "#1f5c3a",
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    map.fitBounds(state.routeLine.getBounds(), { padding: [36, 36] });
    updateSelectHint();
    renderList();
    renderMap();
    renderRouteStops();

    summary.innerHTML = `With <strong>${formatMinutes(budget)}</strong> from <em>${escapeHtml(
      placeLabel
    )}</em> you can cover <strong>${route.length}</strong> shop${
      route.length === 1 ? "" : "s"
    }.<br/>Drive ~${formatMinutes(driveTotal)} + visits ${formatMinutes(
      visitTotal
    )} = <strong>~${formatMinutes(total)}</strong> · ${escapeHtml(
      estimateLabel
    )} (estimate).<br/><a class="time-maps-link" href="${mapsUrl}" target="_blank" rel="noopener">Open this route in Google Maps</a>`;

    stopsBox.hidden = false;
    stopsBox.innerHTML = route
      .map((r, i) => {
        const addr = r.shop.address || `${r.shop.suburb || ""} ${r.shop.postcode || ""}`.trim();
        return `<li>
          <button type="button" class="route-stop-btn" data-open-crm="${r.shop.id}">
            <span class="stop-num">${i + 1}</span>
            <span class="stop-body">
              <strong>${escapeHtml(r.shop.name)}</strong>
              <span class="meta">${escapeHtml(addr || "Address TBD")}</span>
              <span class="meta time-leg">Drive ~${formatMinutes(
                r.driveMins
              )} · visit ${r.visitMins}m</span>
            </span>
          </button>
        </li>`;
      })
      .join("");
  } catch (err) {
    if (summary) summary.textContent = err.message || String(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* —— Find (global) + Add shop (v5) —— */
function loadCustomShops() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_SHOPS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((s) => s && s.id && s.name) : [];
  } catch {
    return [];
  }
}

function saveCustomShops() {
  localStorage.setItem(CUSTOM_SHOPS_KEY, JSON.stringify(state.customShops));
}

function categoryLabel(id) {
  const hit = (state.salesCategories || []).find((c) => c.id === id);
  return hit?.label || id || "other";
}

function sectionForLatLng(lat, lng) {
  const sections = state._sectionsRaw?.sections || state.sections || [];
  for (const sec of sections) {
    const bbox = sec.bbox;
    if (!bbox || bbox.length < 4) continue;
    const [s, w, n, e] = bbox;
    if (lat >= s && lat <= n && lng >= w && lng <= e) return sec.id;
  }
  // nearest section centre
  let best = sections[0]?.id || "inner-melbourne";
  let bestD = Infinity;
  for (const sec of sections) {
    const bbox = sec.bbox;
    if (!bbox) continue;
    const [s, w, n, e] = bbox;
    const cLat = (s + n) / 2;
    const cLng = (w + e) / 2;
    const d = haversineKm([lat, lng], [cLat, cLng]);
    if (d < bestD) {
      bestD = d;
      best = sec.id;
    }
  }
  return best;
}

function rebuildAllShops(baseShops) {
  if (baseShops) {
    state._baseShops = baseShops;
    state.baseShopIds = new Set(baseShops.map((s) => s.id));
  }
  const base = state._baseShops || [];
  const custom = state.customShops || [];
  // custom overrides same id
  const byId = new Map(base.map((s) => [s.id, s]));
  for (const s of custom) byId.set(s.id, s);
  state.allShops = [...byId.values()];
}

function shopMatchesQuery(s, q) {
  if (!q) return true;
  const crm = state.crm.shops[s.id] || {};
  const hay = `${s.name} ${s.address || ""} ${s.suburb || ""} ${s.postcode || ""} ${s.category || ""} ${s.notes || ""} ${s.sales_category_label || ""} ${crm.contactName || ""} ${crm.phone || ""} ${crm.businessNotes || ""}`.toLowerCase();
  return hay.includes(q);
}

function collectFindMatches(q, { scopeToFilters = false, status = "" } = {}) {
  const sectionId = state.selectedSection?.id || "";
  return state.allShops.filter((s) => {
    if (scopeToFilters) {
      if (state.activeCategory && (s.sales_category || "other") !== state.activeCategory) return false;
      if (sectionId && s.section_id !== sectionId) return false;
    }
    if (status && shopStatus(s) !== status) return false;
    return shopMatchesQuery(s, q);
  });
}

function renderFindResults(matches, q) {
  const box = $("findResults");
  if (!box) return;
  if (!q) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  if (!matches.length) {
    box.innerHTML = `<div class="find-empty">
      <p>No shops match “${escapeHtml(q)}”.</p>
      <button type="button" class="btn accent" id="btnAddFromFind">Not in list — Add shop?</button>
    </div>`;
    $("btnAddFromFind")?.addEventListener("click", () => {
      openAddFlow(q);
    });
    return;
  }
  const max = 40;
  const shown = matches.slice(0, max);
  box.innerHTML =
    `<p class="find-count">${matches.length} match${matches.length === 1 ? "" : "es"} across all shops${
      matches.length > max ? ` · showing ${max}` : ""
    }</p>` +
    `<ul class="find-list">` +
    shown
      .map((s) => {
        const addr = s.address || `${s.suburb || ""} ${s.postcode || ""}`.trim();
        const cat = s.sales_category_label || categoryLabel(s.sales_category);
        const custom = s.custom ? ' <span class="tag">yours</span>' : "";
        return `<li>
          <button type="button" class="find-hit" data-jump-shop="${s.id}">
            <strong>${escapeHtml(s.name)}</strong>${custom}
            <span class="meta">${escapeHtml(addr || "Address TBD")}</span>
            <span class="meta">${escapeHtml(cat)} · ${escapeHtml(shopStatus(s))}</span>
          </button>
        </li>`;
      })
      .join("") +
    `</ul>`;
}

function runFind() {
  clearTimeout(state._t);
  const q = ($("searchBox").value || "").trim().toLowerCase();
  const status = $("statusFilter").value;
  const scopeToFilters = Boolean($("findInFilters")?.checked);
  if (!q) {
    const box = $("findResults");
    if (box) {
      box.hidden = false;
      box.innerHTML = `<div class="find-empty"><p>Type a store name, then tap Find.</p></div>`;
    }
    applyFilters();
    return;
  }
  const matches = collectFindMatches(q, { scopeToFilters, status });
  renderFindResults(matches, ($("searchBox").value || "").trim());
  applyFilters();
  if (matches.length === 1) jumpToShop(matches[0].id, { openCrmDrawer: true });
}

function jumpToShop(shopId, { openCrmDrawer = true } = {}) {
  clearTimeout(state._t);
  const shop = state.allShops.find((s) => s.id === shopId);
  if (!shop) return;
  state.highlightId = shopId;
  state.activeCategory = shop.sales_category || "other";
  refreshSectionsForCategory();
  const sec =
    state.sections.find((s) => s.id === shop.section_id) || state.selectedSection;
  state.selectedSection = sec || state.selectedSection;
  renderCategoryTabs();
  renderSections();
  renderSuburbs(state.selectedSection);
  // Clear search scope so list shows this shop in its category/section
  if ($("searchBox")) $("searchBox").value = "";
  applyFilters();
  // Ensure shop visible even if filters would hide it briefly
  if (!state.shops.some((s) => s.id === shopId)) {
    state.shops = [shop, ...state.shops];
    renderList();
    renderMap();
  }
  if (shop.lat != null && shop.lng != null) {
    map.setView([shop.lat, shop.lng], 15);
  }
  state.selectedIds.add(shopId);
  updateSelectHint();
  renderList();
  renderMap();
  if (openCrmDrawer) openCrm(shopId);
  // keep find panel useful
  const box = $("findResults");
  if (box && !box.hidden) {
    for (const btn of box.querySelectorAll(".find-hit")) {
      btn.classList.toggle("active", btn.getAttribute("data-jump-shop") === shopId);
    }
  }
}

function openAddFlow(prefillName) {
  const name = (prefillName || "").trim();
  if ($("addShopName")) $("addShopName").value = name;
  const conf = $("addConfirm");
  const results = $("addLookupResults");
  if (conf) conf.hidden = true;
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  state.pendingAddPlace = null;
  $("addShopName")?.focus();
  $("addShopName")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function parseNominatimAddress(hit) {
  const a = hit.address || {};
  const parts = [
    a.house_number,
    a.road || a.pedestrian || a.footway,
  ].filter(Boolean);
  const suburb = a.suburb || a.town || a.city_district || a.village || a.hamlet || "";
  const postcode = a.postcode || "";
  const address =
    parts.join(" ") ||
    (hit.display_name || "").split(",").slice(0, 2).join(",").trim();
  return { address, suburb, postcode };
}

async function lookupPlaceForAdd() {
  const name = ($("addShopName")?.value || "").trim();
  const results = $("addLookupResults");
  const conf = $("addConfirm");
  if (!name) {
    alert("Enter a shop name first.");
    return;
  }
  if (conf) conf.hidden = true;
  state.pendingAddPlace = null;
  if (results) {
    results.hidden = false;
    results.innerHTML = `<p class="hint">Looking up “${escapeHtml(name)}” in Melbourne…</p>`;
  }
  const btn = $("btnLookupPlace");
  if (btn) btn.disabled = true;
  try {
    const query = /melbourne|vic|australia/i.test(name)
      ? name
      : `${name}, Melbourne VIC, Australia`;
    const params = new URLSearchParams({
      q: query,
      format: "json",
      addressdetails: "1",
      limit: "8",
      countrycodes: "au",
      viewbox: "144.4,-38.5,145.6,-37.4",
      bounded: "0",
    });
    const res = await nominatimFetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) throw new Error("Place lookup failed. Try again or use Google Maps.");
    const rows = await res.json();
    if (!rows.length) {
      results.innerHTML = `<div class="find-empty">
        <p>No OpenStreetMap hits for “${escapeHtml(name)}”.</p>
        <p class="hint">Try a fuller name, or Open in Google Maps to verify.</p>
      </div>`;
      return;
    }
    results.innerHTML =
      `<p class="find-count">${rows.length} place${rows.length === 1 ? "" : "s"} — pick one</p>` +
      `<ul class="find-list">` +
      rows
        .map((hit, i) => {
          const { address, suburb, postcode } = parseNominatimAddress(hit);
          const label = hit.display_name || `${address} ${suburb}`;
          return `<li>
            <button type="button" class="find-hit" data-pick-place="${i}">
              <strong>${escapeHtml(hit.name || name)}</strong>
              <span class="meta">${escapeHtml(label)}</span>
            </button>
          </li>`;
        })
        .join("") +
      `</ul>`;
    state._addLookupRows = rows;
    if (rows.length === 1) selectAddPlace(0);
  } catch (err) {
    if (results) results.innerHTML = `<p class="hint">${escapeHtml(err.message || String(err))}</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function selectAddPlace(index) {
  const rows = state._addLookupRows || [];
  const hit = rows[index];
  if (!hit) return;
  const name = ($("addShopName")?.value || "").trim() || hit.name || "New shop";
  const { address, suburb, postcode } = parseNominatimAddress(hit);
  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  state.pendingAddPlace = {
    name,
    address,
    suburb,
    postcode,
    lat,
    lng,
    osm_id: hit.osm_id,
    display_name: hit.display_name,
  };
  const conf = $("addConfirm");
  const sum = $("addConfirmSummary");
  if (sum) {
    sum.textContent = `${name} — ${address || suburb || hit.display_name} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
  }
  if (conf) conf.hidden = false;
  for (const btn of ($("addLookupResults")?.querySelectorAll(".find-hit") || [])) {
    btn.classList.toggle("active", btn.getAttribute("data-pick-place") === String(index));
  }
}

function saveCustomShop() {
  const pending = state.pendingAddPlace;
  if (!pending || pending.lat == null) {
    alert("Lookup and pick a place first.");
    return;
  }
  const cat = $("addCategory")?.value || "western_premium";
  const id = `custom-${String(pending.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}-${Date.now().toString(36)}`;
  const sectionId = sectionForLatLng(pending.lat, pending.lng);
  const shop = {
    id,
    name: pending.name,
    address: pending.address || "",
    suburb: pending.suburb || "",
    postcode: pending.postcode || "",
    lat: pending.lat,
    lng: pending.lng,
    category: "custom",
    notes: pending.display_name ? `Added via OSM: ${pending.display_name}` : "Added by user",
    phone: "",
    website: "",
    priority: cat === "western_premium" ? "high" : "medium",
    status: "prospect",
    sales_category: cat,
    sales_category_label: categoryLabel(cat),
    sales_category_reason: "user_added",
    section_id: sectionId,
    source: "custom",
    custom: true,
    updated_at: new Date().toISOString(),
  };
  state.customShops.push(shop);
  saveCustomShops();
  rebuildAllShops();
  const rec = getCrm(id);
  rec.status = "prospect";
  rec.updatedAt = new Date().toISOString();
  saveCrm();
  state.pendingAddPlace = null;
  $("addConfirm").hidden = true;
  $("addLookupResults").hidden = true;
  $("addLookupResults").innerHTML = "";
  refreshSectionsForCategory();
  jumpToShop(id, { openCrmDrawer: true });
  alert(`Saved “${shop.name}” to your list (this browser).`);
}

function openAddInGoogleMaps() {
  const name = ($("addShopName")?.value || "").trim() || ($("searchBox")?.value || "").trim();
  if (!name) {
    alert("Enter a shop name first.");
    return;
  }
  const q = /melbourne|vic/i.test(name) ? name : `${name} Melbourne`;
  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    "_blank",
    "noopener"
  );
}

/* —— Intelligent day nav (v6) —— */
const SALES_RELEVANT = new Set(["western_premium", "indian", "asian", "health_chains"]);

async function geocodeMelbourne(raw, { asArea = false } = {}) {
  const pasted = parseLatLng(raw);
  if (pasted) return pasted;
  const q = String(raw || "").trim();
  if (!q) throw new Error("Enter a shop name, suburb, postcode, or address.");

  // Pure postcode
  if (/^\d{4}$/.test(q)) {
    const params = new URLSearchParams({
      postalcode: q,
      country: "Australia",
      format: "json",
      addressdetails: "1",
      limit: "1",
      countrycodes: "au",
    });
    const res = await nominatimFetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) throw new Error("Postcode lookup failed.");
    const rows = await res.json();
    if (!rows.length) throw new Error(`Postcode ${q} not found.`);
    return {
      lat: parseFloat(rows[0].lat),
      lng: parseFloat(rows[0].lon),
      label: rows[0].display_name || `Postcode ${q}`,
      kind: "postcode",
    };
  }

  const query = /melbourne|vic|australia/i.test(q) ? q : `${q}, Melbourne VIC, Australia`;
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "5",
    countrycodes: "au",
    viewbox: "144.4,-38.5,145.6,-37.4",
    bounded: "0",
  });
  const res = await nominatimFetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error("Location lookup failed.");
  const rows = await res.json();
  if (!rows.length) throw new Error(`Nothing found for “${q}”.`);

  // Prefer suburb/locality for area-ish queries; prefer amenity/shop for shop names
  const areaTypes = new Set(["suburb", "neighbourhood", "city_district", "quarter", "town", "village", "postcode"]);
  let pick = rows[0];
  if (asArea || /^\d{4}$/.test(q) || q.split(/\s+/).length <= 3) {
    pick =
      rows.find((r) => areaTypes.has(r.type) || areaTypes.has(r.addresstype)) ||
      rows.find((r) => (r.class === "place" || r.class === "boundary")) ||
      rows[0];
  }
  return {
    lat: parseFloat(pick.lat),
    lng: parseFloat(pick.lon),
    label: pick.display_name || q,
    kind: pick.type || pick.class || "place",
    name: pick.name || q,
  };
}

function shopsNearPoint(center, radiusKm, { allCats = false } = {}) {
  const cat = state.activeCategory || "western_premium";
  return state.allShops
    .filter((s) => {
      if (s.lat == null || s.lng == null) return false;
      const sc = s.sales_category || "other";
      if (allCats) {
        if (!SALES_RELEVANT.has(sc)) return false;
      } else if (sc !== cat) {
        return false;
      }
      const d = haversineKm([center.lat, center.lng], [s.lat, s.lng]);
      s._distKm = d;
      return d <= radiusKm;
    })
    .sort((a, b) => (a._distKm || 0) - (b._distKm || 0));
}

function clearIntelUi() {
  const sum = $("intelSummary");
  const stops = $("intelStops");
  const actions = $("intelActions");
  if (sum) sum.innerHTML = "";
  if (stops) {
    stops.hidden = true;
    stops.innerHTML = "";
  }
  if (actions) actions.hidden = true;
  if (state.intelCircle) {
    map.removeLayer(state.intelCircle);
    state.intelCircle = null;
  }
  state.intelPlan = null;
}

function buildTimeBudgetRoute(origin, candidates, budgetMins, visitMins) {
  // Greedy by lead-score per minute (Badger/Mapline: balance visit value vs travel)
  const remaining = new Set(candidates.map((_, i) => i));
  const route = [];
  let used = 0;
  let cur = { lat: origin.lat, lng: origin.lng };
  while (remaining.size) {
    let best = null;
    for (const i of remaining) {
      const shop = candidates[i];
      const drive = driveMinutesHaversine(cur, shop);
      const cost = drive + visitMins;
      if (used + cost > budgetMins + 0.05) continue;
      const value = Math.max(1, leadScore(shop, origin));
      const scorePerMin = value / Math.max(8, cost);
      if (!best || scorePerMin > best.score) best = { i, shop, drive, cost, score: scorePerMin };
    }
    if (!best) break;
    route.push({ shop: best.shop, driveMins: best.drive, visitMins });
    used += best.cost;
    remaining.delete(best.i);
    cur = { lat: best.shop.lat, lng: best.shop.lng };
  }
  if (route.length >= 3) {
    const ordered = optimizeOrder(
      route.map((r) => r.shop),
      origin
    );
    const rebuilt = [];
    let pos = { lat: origin.lat, lng: origin.lng };
    let total = 0;
    for (const shop of ordered.shops) {
      const drive = driveMinutesHaversine(pos, shop);
      const cost = drive + visitMins;
      if (total + cost > budgetMins + 0.05 && rebuilt.length) break;
      rebuilt.push({ shop, driveMins: drive, visitMins });
      total += cost;
      pos = { lat: shop.lat, lng: shop.lng };
    }
    if (rebuilt.length) return { route: rebuilt, usedMins: total };
  }
  return { route, usedMins: used };
}

function formatIntelPlanText(plan) {
  const lines = [
    `Nature's Pinch — day plan`,
    `Area: ${plan.areaLabel}`,
    `Start: ${plan.startLabel}`,
    `Radius: ${plan.radiusKm} km · Budget: ${formatMinutes(plan.budgetMins)} · Visit: ${plan.visitMins}m/shop`,
    `Nearby candidates: ${plan.nearbyCount} · On route: ${plan.route.length}`,
    `Est. total: ~${formatMinutes(plan.usedMins)} (drive + visits; estimate)`,
    "",
  ];
  plan.route.forEach((r, i) => {
    const addr = r.shop.address || `${r.shop.suburb || ""} ${r.shop.postcode || ""}`.trim();
    lines.push(
      `${i + 1}. ${r.shop.name} — ${addr || "TBD"} · drive ~${formatMinutes(r.driveMins)} + visit ${r.visitMins}m`
    );
  });
  if (plan.mapsUrl) {
    lines.push("", `Maps: ${plan.mapsUrl}`);
  }
  return lines.join("\n");
}

async function runIntelligentNav() {
  const query = ($("intelQuery")?.value || "").trim();
  const startRaw = ($("intelStart")?.value || "").trim();
  const radiusKm = parseFloat($("intelRadius")?.value || "4") || 4;
  const hours = parseFloat($("intelHours")?.value || "3") || 3;
  const visitMins = parseFloat($("intelVisit")?.value || "30") || 30;
  const allCats = Boolean($("intelAllCats")?.checked);
  const summary = $("intelSummary");
  const btn = $("btnIntelNav");
  if (!query) {
    alert("Enter a shop name, suburb, postcode, or address.");
    return;
  }
  if (btn) btn.disabled = true;
  if (summary) summary.textContent = "Resolving location…";
  clearIntelUi();
  if (summary) summary.textContent = "Resolving location…";

  try {
    // First: try matching as shop name in our list (fast, no network)
    const qLower = query.toLowerCase();
    const nameHits = state.allShops.filter((s) => (s.name || "").toLowerCase().includes(qLower));
    let area;
    if (nameHits.length === 1 && nameHits[0].lat != null) {
      const s = nameHits[0];
      area = {
        lat: s.lat,
        lng: s.lng,
        label: `${s.name}${s.suburb ? " · " + s.suburb : ""}`,
        kind: "shop",
        shopId: s.id,
      };
    } else if (/^\d{4}$/.test(query) || nameHits.length === 0) {
      area = await geocodeMelbourne(query, { asArea: true });
    } else if (nameHits.length > 1) {
      // Prefer hit in active category, else first with coords
      const preferred =
        nameHits.find((s) => (s.sales_category || "") === state.activeCategory && s.lat != null) ||
        nameHits.find((s) => s.lat != null);
      if (preferred) {
        area = {
          lat: preferred.lat,
          lng: preferred.lng,
          label: `${preferred.name}${preferred.suburb ? " · " + preferred.suburb : ""} (${nameHits.length} name matches — using this)`,
          kind: "shop",
          shopId: preferred.id,
        };
      } else {
        area = await geocodeMelbourne(query, { asArea: true });
      }
    } else {
      area = await geocodeMelbourne(query, { asArea: true });
    }

    let start = area;
    if (startRaw) {
      if (summary) summary.textContent = "Resolving start address…";
      start = await geocodeMelbourne(startRaw);
    }
    state.driverOrigin = { lat: start.lat, lng: start.lng, label: start.label };

    const nearby = shopsNearPoint(area, radiusKm, { allCats });
    // Draw radius
    if (state.intelCircle) map.removeLayer(state.intelCircle);
    state.intelCircle = L.circle([area.lat, area.lng], {
      radius: radiusKm * 1000,
      color: "#1f5c3a",
      weight: 2,
      fillColor: "#1f5c3a",
      fillOpacity: 0.08,
    }).addTo(map);

    if (!nearby.length) {
      summary.innerHTML = `No shops within <strong>${radiusKm} km</strong> of <em>${escapeHtml(
        area.label.split(",")[0]
      )}</em> for ${
        allCats ? "sales-relevant categories" : escapeHtml(categoryLabel(state.activeCategory))
      }. Try a larger radius or include all categories.`;
      map.setView([area.lat, area.lng], 13);
      $("intelActions").hidden = true;
      return;
    }

    if (summary) summary.textContent = `Found ${nearby.length} nearby — building time-budget route…`;
    const budgetMins = hours * 60;
    const { route, usedMins } = buildTimeBudgetRoute(start, nearby, budgetMins, visitMins);

    // Sync into main route UI
    state.selectedIds = new Set(route.map((r) => r.shop.id));
    state.routeStops = route.map((r) => r.shop);
    const coords = [[start.lat, start.lng], ...route.map((r) => [r.shop.lat, r.shop.lng])];
    const mapsUrl = mapsDirUrl(coords);
    state.routeUrl = mapsUrl;
    $("btnOpenRoute").disabled = !mapsUrl;
    if (state._syncSticky) state._syncSticky();
    renderMapsChunkButtons(coords);

    if (state.routeLine) map.removeLayer(state.routeLine);
    if (coords.length >= 2) {
      state.routeLine = L.polyline(coords, {
        color: "#c45c26",
        weight: 4,
        opacity: 0.9,
      }).addTo(map);
      const bounds = L.latLngBounds(coords);
      if (state.intelCircle) bounds.extend(state.intelCircle.getBounds());
      map.fitBounds(bounds, { padding: [36, 36] });
    }

    // Show nearby set in list (route order first)
    const routeIds = new Set(route.map((r) => r.shop.id));
    state.shops = [
      ...route.map((r) => r.shop),
      ...nearby.filter((s) => !routeIds.has(s.id)),
    ];
    $("routeSummary").textContent = `Day nav: ${route.length} stops · ~${formatMinutes(usedMins)} · ${nearby.length} nearby`;
    updateSelectHint();
    renderList();
    renderMap();
    renderRouteStops();

    const areaShort = (area.label || "").split(",")[0];
    const startShort = (start.label || areaShort).split(",")[0];
    const plan = {
      areaLabel: area.label,
      startLabel: start.label || area.label,
      radiusKm,
      budgetMins,
      visitMins,
      nearbyCount: nearby.length,
      route,
      usedMins,
      mapsUrl,
    };
    state.intelPlan = plan;

    summary.innerHTML = `Near <strong>${escapeHtml(areaShort)}</strong> (${radiusKm} km): <strong>${
      nearby.length
    }</strong> shops · route covers <strong>${route.length}</strong> in ~${formatMinutes(
      usedMins
    )} from <em>${escapeHtml(startShort)}</em>.<br/>
    <span class="meta">Category: ${
      allCats ? "all sales-relevant" : escapeHtml(categoryLabel(state.activeCategory))
    } · drive times are estimates</span>`;

    const stops = $("intelStops");
    stops.hidden = false;
    stops.innerHTML = route
      .map((r, i) => {
        const addr = r.shop.address || `${r.shop.suburb || ""} ${r.shop.postcode || ""}`.trim();
        return `<li>
          <button type="button" class="route-stop-btn" data-open-crm="${r.shop.id}">
            <span class="stop-num">${i + 1}</span>
            <span class="stop-body">
              <strong>${escapeHtml(r.shop.name)}</strong>
              <span class="meta">${escapeHtml(addr || "Address TBD")} · ${((r.shop._distKm || 0).toFixed(1))} km from centre</span>
              <span class="meta time-leg">Drive ~${formatMinutes(r.driveMins)} · visit ${r.visitMins}m</span>
            </span>
          </button>
        </li>`;
      })
      .join("");

    $("intelActions").hidden = false;
  } catch (err) {
    if (summary) summary.textContent = err.message || String(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindEvents() {
  $("categoryTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-category]");
    if (!btn) return;
    const next = btn.getAttribute("data-category");
    if (!next || next === state.activeCategory) {
      // still re-apply so UI stays honest
    }
    state.activeCategory = next;
    state.selectedIds.clear();
    clearRouteUi();
    clearTimePlanUi();
    clearIntelUi();
    updateSelectHint();
    refreshSectionsForCategory();
    renderCategoryTabs();
    renderSuburbs(state.selectedSection);
    applyFilters();
    fitToVisibleShops();
    setTimeout(() => map.invalidateSize(), 80);
  });
  $("sectionSelect").addEventListener("change", (e) => {
    state.selectedSection = state.sections.find((s) => s.id === e.target.value);
    state.selectedIds.clear();
    clearRouteUi();
    clearTimePlanUi();
    clearIntelUi();
    updateSelectHint();
    renderSuburbs(state.selectedSection);
    applyFilters();
    fitToVisibleShops();
    setTimeout(() => map.invalidateSize(), 80);
  });
  $("searchBox").addEventListener("input", () => {
    clearTimeout(state._t);
    state._t = setTimeout(applyFilters, 200);
  });
  $("searchBox").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runFind();
    }
  });
  $("statusFilter").addEventListener("change", () => {
    applyFilters();
    if (($("searchBox").value || "").trim()) runFind();
  });
  $("findInFilters")?.addEventListener("change", () => {
    applyFilters();
    if (($("searchBox").value || "").trim()) runFind();
  });
  $("btnFind")?.addEventListener("click", runFind);
  $("findResults")?.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-jump-shop]");
    if (hit) {
      jumpToShop(hit.getAttribute("data-jump-shop"));
      return;
    }
  });
  $("btnLookupPlace")?.addEventListener("click", () => lookupPlaceForAdd());
  $("btnAddMaps")?.addEventListener("click", openAddInGoogleMaps);
  $("btnSaveCustomShop")?.addEventListener("click", saveCustomShop);
  $("addLookupResults")?.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick-place]");
    if (pick) selectAddPlace(parseInt(pick.getAttribute("data-pick-place"), 10));
  });
  $("btnOpenMaps").addEventListener("click", () => {
    const url = state.selectedSection?.google_maps_url;
    if (url) window.open(url, "_blank", "noopener");
  });
  $("btnSelectVisible").addEventListener("click", () => {
    state.shops.forEach((s) => state.selectedIds.add(s.id));
    updateSelectHint();
    renderList();
    renderMap();
  });
  $("btnClearSelect").addEventListener("click", () => {
    state.selectedIds.clear();
    clearRouteUi();
    updateSelectHint();
    renderList();
    renderMap();
  });
  $("btnRoute").addEventListener("click", buildRoute);
  $("btnOpenRoute").addEventListener("click", () => {
    if (state.routeUrl) window.open(state.routeUrl, "_blank", "noopener");
  });
  $("btnPlanByTime")?.addEventListener("click", () => {
    planByTime();
  });
  $("timePlanStops")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-crm]");
    if (btn) openCrm(btn.getAttribute("data-open-crm"));
  });
  $("btnIntelNav")?.addEventListener("click", () => runIntelligentNav());
  $("intelQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runIntelligentNav();
    }
  });
  $("btnIntelClear")?.addEventListener("click", () => {
    clearIntelUi();
    clearRouteUi();
    applyFilters();
    fitToVisibleShops();
  });
  $("btnIntelMaps")?.addEventListener("click", () => {
    if (state.routeUrl) window.open(state.routeUrl, "_blank", "noopener");
  });
  $("btnIntelCopy")?.addEventListener("click", async () => {
    if (!state.intelPlan) return;
    const text = formatIntelPlanText(state.intelPlan);
    try {
      await navigator.clipboard.writeText(text);
      alert("Plan copied.");
    } catch {
      prompt("Copy plan:", text);
    }
  });
  $("intelStops")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-crm]");
    if (btn) openCrm(btn.getAttribute("data-open-crm"));
  });
  const stickyRoute = $("btnRouteSticky");
  const stickyOpen = $("btnOpenRouteSticky");
  if (stickyRoute) stickyRoute.addEventListener("click", () => $("btnRoute").click());
  if (stickyOpen) {
    stickyOpen.addEventListener("click", () => $("btnOpenRoute").click());
  }
  const syncSticky = () => {
    if (stickyOpen) stickyOpen.disabled = $("btnOpenRoute").disabled;
  };
  state._syncSticky = syncSticky;
  const exportMd = $("btnExportMd");
  if (exportMd) exportMd.addEventListener("click", downloadMarkdown);
  $("btnExportCrmJson").addEventListener("click", exportCrmJson);
  $("btnExportCrmCsv").addEventListener("click", exportCrmCsv);
  $("crmImportFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importCrmJson(file);
    e.target.value = "";
  });
  $("crmClose").addEventListener("click", closeCrm);
  $("crmDrawer").addEventListener("click", (e) => {
    if (e.target === $("crmDrawer")) closeCrm();
  });
  $("crmForm").addEventListener("submit", saveCrmForm);
  $("crmStatusRow").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-crm-status]");
    if (!btn || !state.activeShopId) return;
    setStatus(state.activeShopId, btn.getAttribute("data-crm-status"), {
      openCrmOnVisited: false,
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCrm();
  });
  window.addEventListener("resize", () => {
    clearTimeout(state._resize);
    state._resize = setTimeout(() => map.invalidateSize(), 150);
  });
  $("shopList").addEventListener("click", (e) => {
    const t = e.target;
    if (t.matches("input[data-select]")) {
      toggleSelect(t.getAttribute("data-select"));
      return;
    }
    const open = t.closest("[data-open-crm]");
    if (open) {
      openCrm(open.getAttribute("data-open-crm"));
      return;
    }
    if (t.matches("button[data-status]")) {
      setStatus(t.getAttribute("data-id"), t.getAttribute("data-status"));
    }
  });
  $("routeStops").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-crm]");
    if (btn) openCrm(btn.getAttribute("data-open-crm"));
  });
  $("leadSort")?.addEventListener("change", applyFilters);
  $("btnDeleteCustom")?.addEventListener("click", deleteCustomShop);
  $("routeMapsChunks")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-maps-chunk]");
    if (!btn) return;
    const i = parseInt(btn.getAttribute("data-maps-chunk"), 10);
    const url = state.routeChunks?.[i];
    if (url) window.open(url, "_blank", "noopener");
  });
}

async function boot() {
  initLayoutSwitcher();
  bindEvents();
  saveCrm(); // persist migrated status
  state.customShops = loadCustomShops();
  const data = await fetch(`./data/shops.json?v=${SHOPS_CACHE_BUST}`).then((r) => r.json());
  state.salesCategories = data.sales_categories || [];
  state.center = data.sections?.center || state.center;
  state._sectionsRaw = data.sections || { sections: [] };
  rebuildAllShops(data.shops || []);
  state.activeCategory = "western_premium";
  state.sections = enrichSections(state._sectionsRaw);
  state.selectedSection = state.sections[0];
  updateStatusLine();
  renderCategoryTabs();
  renderSections();
  renderSuburbs(state.selectedSection);
  applyFilters();
  fitToVisibleShops();
  updateSelectHint();
  if (state._syncSticky) state._syncSticky();
  setTimeout(() => map.invalidateSize(), 80);
}

boot().catch((err) => {
  $("statusLine").textContent = `Failed to load: ${err.message}`;
});
