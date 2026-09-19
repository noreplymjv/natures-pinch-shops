const STATUS_KEY = "np-shop-status-v1";
const CRM_KEY = "np-crm-v1";
const LAYOUT_KEY = "np-layout-mode";

const state = {
  allShops: [],
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

function mapsSearchUrl(query, lat, lng, zoom = 13) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat},${lng},${zoom}z`;
}

function mapsDirUrl(coords) {
  if (!coords.length) return "";
  return "https://www.google.com/maps/dir/" + coords.map(([lat, lng]) => `${lat},${lng}`).join("/");
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
  for (let i = 0; i < coords.length - 1; i++) n += haversineKm(coords[i], coords[i + 1]);
  return n;
}

function optimizeOrder(shops) {
  const usable = shops.filter((s) => s.lat != null && s.lng != null);
  if (!usable.length) return { shops: [], distanceKm: 0, coords: [] };
  const coords = usable.map((s) => [s.lat, s.lng]);
  const unvisited = new Set(usable.map((_, i) => i));
  const order = [0];
  unvisited.delete(0);
  while (unvisited.size) {
    const last = order[order.length - 1];
    let best = null;
    let bestD = Infinity;
    for (const i of unvisited) {
      const d = haversineKm(coords[last], coords[i]);
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

function enrichSections(raw) {
  const counts = {};
  for (const s of state.allShops) {
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
    const st = shopStatus(shop);
    const n = stopIndex[shop.id];
    const marker = L.circleMarker([shop.lat, shop.lng], {
      radius: n ? 10 : state.selectedIds.has(shop.id) ? 9 : 7,
      color: "#fff",
      weight: 2,
      fillColor: n ? "#c45c26" : markerColor(st),
      fillOpacity: 0.9,
    });
    const title = n ? `Stop ${n}: ${shop.name}` : shop.name;
    marker.bindPopup(
      `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(shop.address || "")}<br><em>${escapeHtml(shop.category || "")}</em>`
    );
    marker.on("click", () => openCrm(shop.id, { fromMap: true }));
    marker.addTo(shopLayer);
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
            <span class="tag">${escapeHtml(st)}</span>
            ${crmBadge(shop.id)}
            <span class="tag">${escapeHtml(shop.category || "specialty")}</span>
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
  $("statusLine").textContent = `${state.allShops.length} shops · ${crmCount} with CRM notes`;
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
  // If a route is active and no filters, keep showing route order unless section/search changes
  state.shops = state.allShops.filter((s) => {
    if (sectionId && s.section_id !== sectionId) return false;
    if (status && shopStatus(s) !== status) return false;
    if (q) {
      const crm = state.crm.shops[s.id] || {};
      const hay = `${s.name} ${s.address || ""} ${s.suburb || ""} ${s.category || ""} ${s.notes || ""} ${crm.contactName || ""} ${crm.phone || ""} ${crm.businessNotes || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (state.routeStops.length && !q && !status) {
    const ids = new Set(state.shops.map((s) => s.id));
    const ordered = state.routeStops.filter((s) => ids.has(s.id));
    const rest = state.shops.filter((s) => !state.routeStops.some((r) => r.id === s.id));
    if (ordered.length) state.shops = ordered.concat(rest);
  }
  renderList();
  renderMap();
  renderRouteStops();
}

function setStatus(id, status, { openCrmOnVisited = true } = {}) {
  const rec = getCrm(id);
  rec.status = status;
  rec.updatedAt = new Date().toISOString();
  if (status === "visited" && !rec.visitDate) {
    rec.visitDate = new Date().toISOString().slice(0, 10);
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
  const result = optimizeOrder(picked);
  state.routeStops = result.shops;
  state.routeUrl = mapsDirUrl(result.coords);
  $("btnOpenRoute").disabled = !state.routeUrl;
  if (state._syncSticky) state._syncSticky();
  $("routeSummary").textContent = `Ready: ${result.shops.length} stops · ~${result.distanceKm} km`;
  if (state.routeLine) map.removeLayer(state.routeLine);
  if (result.coords.length) {
    state.routeLine = L.polyline(result.coords, {
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
  $("btnOpenRoute").disabled = true;
  if (state._syncSticky) state._syncSticky();
  $("routeSummary").textContent = "";
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
  if (fromMap) {
    // map click: also toggle select lightly for route building
    if (!state.selectedIds.has(shopId)) {
      state.selectedIds.add(shopId);
      updateSelectHint();
    }
  }
  state.activeShopId = shopId;
  fillCrmForm(shopId);
  const drawer = $("crmDrawer");
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("crm-open");
  renderList();
  renderMap();
  setTimeout(() => {
    if (focusNotes) $("crmLogEntry").focus();
    else $("crmContactName").focus();
  }, 50);
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
    version: 1,
    exported_at: new Date().toISOString(),
    shops: state.crm.shops,
  };
  downloadBlob(
    `natures-pinch-crm-${new Date().toISOString().slice(0, 10)}.json`,
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
    `natures-pinch-crm-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.join("\n") + "\n",
    "text/csv"
  );
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
        const base = getCrm(id);
        state.crm.shops[id] = {
          ...emptyCrmRecord(),
          ...base,
          ...rec,
          visitLog: Array.isArray(rec.visitLog)
            ? rec.visitLog
            : base.visitLog || [],
        };
        n += 1;
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

function bindEvents() {
  $("sectionSelect").addEventListener("change", (e) => {
    state.selectedSection = state.sections.find((s) => s.id === e.target.value);
    state.selectedIds.clear();
    clearRouteUi();
    updateSelectHint();
    renderSuburbs(state.selectedSection);
    fitSection(state.selectedSection);
    applyFilters();
    setTimeout(() => map.invalidateSize(), 80);
  });
  $("searchBox").addEventListener("input", () => {
    clearTimeout(state._t);
    state._t = setTimeout(applyFilters, 200);
  });
  $("statusFilter").addEventListener("change", applyFilters);
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
}

async function boot() {
  initLayoutSwitcher();
  bindEvents();
  saveCrm(); // persist migrated status
  const data = await fetch("../data/shops.json").then((r) => r.json());
  state.allShops = data.shops || [];
  state.center = data.sections?.center || state.center;
  state.sections = enrichSections(data.sections || { sections: [] });
  state.selectedSection = state.sections[0];
  updateStatusLine();
  renderSections();
  renderSuburbs(state.selectedSection);
  fitSection(state.selectedSection);
  applyFilters();
  updateSelectHint();
  if (state._syncSticky) state._syncSticky();
  setTimeout(() => map.invalidateSize(), 80);
}

boot().catch((err) => {
  $("statusLine").textContent = `Failed to load: ${err.message}`;
});
