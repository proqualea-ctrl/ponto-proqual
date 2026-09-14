// =============================================================
// PROQUAL — Ponto de Presença — lógica da aplicação
// Vanilla JS, sem build step. Usa o Supabase JS SDK (via CDN).
// =============================================================
(function () {
  "use strict";

  const cfg = window.APP_CONFIG;
  const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // -----------------------------------------------------------
  // Estado da sessão de registo em curso
  // -----------------------------------------------------------
  const state = {
    employees: [],
    locations: [],
    selectedEmployee: null,
    selectedLocation: null,
    direction: null,
    cameraStream: null,
    photoBlob: null,
    gps: { status: "loading", lat: null, lng: null, accuracy: null },
    geofence: { distance: null, within: null },
    duplicateWarning: null,
    session: null, // sessão de auth da Gestão
    role: null,    // 'admin' | 'encarregado' | null
    dashboard: { records: [], employees: [], locations: [] },
    newLocationGeo: { lat: null, lng: null }, // captura usada nos formulários "+ Novo local"
    installPromptEvent: null,
    editingRecordId: null,
  };

  // -----------------------------------------------------------
  // Geofencing: distância entre dois pontos GPS (fórmula de Haversine)
  // -----------------------------------------------------------
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000; // raio da Terra em metros
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // -----------------------------------------------------------
  // Navegação entre ecrãs
  // -----------------------------------------------------------
  function showScreen(name) {
    document.querySelectorAll(".screen").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.screen === name);
    });
    if (name !== "confirm-presence") stopCamera();
    if (name === "employee-select") renderEmployeeList();
    if (name === "location-select") renderLocationList();
    if (name === "confirm-presence") enterConfirmScreen();
    if (name === "admin-dashboard") loadDashboard();
  }

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) { showScreen(nav.dataset.nav); return; }
    const back = e.target.closest("[data-back]");
    if (back) { showScreen(back.dataset.back); return; }
    const dirBtn = e.target.closest("[data-direction]");
    if (dirBtn) {
      state.direction = dirBtn.dataset.direction;
      checkDuplicateDirection().then(() => showScreen("confirm-presence"));
      return;
    }
  });

  // -----------------------------------------------------------
  // Evitar registos duplicados: avisa se o último registo deste
  // funcionário já tinha a mesma direção (ex: duas entradas seguidas
  // sem uma saída pelo meio).
  // -----------------------------------------------------------
  async function checkDuplicateDirection() {
    state.duplicateWarning = null;
    if (!state.selectedEmployee) return;
    try {
      const { data, error } = await supabase
        .from("attendance_records")
        .select("direction, created_at, locations(name)")
        .eq("employee_id", state.selectedEmployee.id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) { console.error(error); return; }
      const last = data && data[0];
      if (last && last.direction === state.direction) {
        const when = new Date(last.created_at).toLocaleString("pt-PT");
        state.duplicateWarning = state.direction === "entrada"
          ? `Atenção: já existe uma ENTRADA registada em ${when} (${last.locations?.name || "—"}) sem SAÍDA correspondente.`
          : `Atenção: já existe uma SAÍDA registada em ${when} (${last.locations?.name || "—"}) sem ENTRADA correspondente.`;
      }
    } catch (err) {
      console.error(err);
    }
  }

  function toast(msg, isError) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    t.classList.toggle("toast--error", !!isError);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // -----------------------------------------------------------
  // Branding (a partir de config.js)
  // -----------------------------------------------------------
  document.getElementById("home-subtitle").textContent = cfg.APP_SUBTITLE;
  document.title = cfg.APP_TITLE + " — Registo de Presença";

  // -----------------------------------------------------------
  // PWA: instalar no telemóvel + service worker
  // -----------------------------------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW falhou:", err));
    });
  }

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const installBtn = document.getElementById("install-btn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installPromptEvent = e;
    if (!isStandalone) installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!state.installPromptEvent) return;
    state.installPromptEvent.prompt();
    await state.installPromptEvent.userChoice;
    state.installPromptEvent = null;
    installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    state.installPromptEvent = null;
  });

  // -----------------------------------------------------------
  // Funcionários
  // -----------------------------------------------------------
  async function loadEmployees() {
    const { data, error } = await supabase
      .from("employees")
      .select("*")
      .eq("active", true)
      .order("name");
    if (error) { console.error(error); toast("Erro ao carregar funcionários", true); return; }
    state.employees = data || [];
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
  }

  function renderEmployeeList() {
    const box = document.getElementById("employee-list");
    box.innerHTML = "";
    loadEmployees().then(() => {
      if (!state.employees.length) {
        box.innerHTML = '<p class="list-empty">Ainda não há funcionários. Cria o primeiro abaixo.</p>';
        return;
      }
      state.employees.forEach((emp) => {
        const btn = document.createElement("button");
        btn.className = "list-item";
        btn.innerHTML = `
          <span class="li-main">
            <span class="avatar">${initials(emp.name)}</span>
            <span class="li-name">${escapeHtml(emp.name)}</span>
          </span>
          <span class="li-tag">${emp.department || "—"}</span>
        `;
        btn.addEventListener("click", () => {
          state.selectedEmployee = emp;
          showScreen("location-select");
        });
        box.appendChild(btn);
      });
    });
  }

  document.getElementById("new-employee-continue").addEventListener("click", async () => {
    const nameInput = document.getElementById("new-employee-name");
    const deptInput = document.getElementById("new-employee-dept");
    const name = nameInput.value.trim();
    if (!name) { toast("Escreve o teu nome", true); return; }
    const { data, error } = await supabase
      .from("employees")
      .insert({ name, department: deptInput.value })
      .select()
      .single();
    if (error) { console.error(error); toast("Não foi possível criar o funcionário", true); return; }
    nameInput.value = "";
    state.selectedEmployee = data;
    showScreen("location-select");
  });

  // -----------------------------------------------------------
  // Locais (obras + escritório)
  // -----------------------------------------------------------
  async function loadLocations() {
    const { data, error } = await supabase
      .from("locations")
      .select("*")
      .eq("active", true)
      .order("type")
      .order("name");
    if (error) { console.error(error); toast("Erro ao carregar locais", true); return; }
    state.locations = data || [];
  }

  function locationIcon(type) { return type === "escritorio" ? "🏢" : "🏗️"; }
  function locationLabel(type) { return type === "escritorio" ? "Escritório" : "Obra"; }

  function renderLocationList() {
    const box = document.getElementById("location-list");
    box.innerHTML = "";
    loadLocations().then(() => {
      if (!state.locations.length) {
        box.innerHTML = '<p class="list-empty">Ainda não há locais. Cria o primeiro abaixo.</p>';
        return;
      }
      state.locations.forEach((loc) => {
        const btn = document.createElement("button");
        btn.className = "list-item";
        btn.innerHTML = `
          <span class="li-main">
            <span class="avatar">${locationIcon(loc.type)}</span>
            <span class="li-name">${escapeHtml(loc.name)}</span>
          </span>
          <span class="li-tag">${locationLabel(loc.type)}</span>
        `;
        btn.addEventListener("click", () => {
          state.selectedLocation = loc;
          showScreen("direction-select");
        });
        box.appendChild(btn);
      });
    });
  }

  function captureGeoInto(statusElId, target) {
    const status = document.getElementById(statusElId);
    if (!("geolocation" in navigator)) {
      status.textContent = "Sem suporte de GPS neste dispositivo.";
      status.className = "geo-status geo-status--err";
      return;
    }
    status.textContent = "A obter localização…";
    status.className = "geo-status";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        target.lat = pos.coords.latitude;
        target.lng = pos.coords.longitude;
        status.textContent = `📍 Localização capturada (±${Math.round(pos.coords.accuracy)}m)`;
        status.className = "geo-status geo-status--ok";
      },
      (err) => {
        console.warn(err);
        status.textContent = "Não foi possível obter a localização.";
        status.className = "geo-status geo-status--err";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  document.getElementById("new-location-geo-btn").addEventListener("click", () => {
    captureGeoInto("new-location-geo-status", state.newLocationGeo);
  });

  document.getElementById("new-location-continue").addEventListener("click", async () => {
    const nameInput = document.getElementById("new-location-name");
    const typeInput = document.getElementById("new-location-type");
    const name = nameInput.value.trim();
    if (!name) { toast("Escreve o nome do local", true); return; }
    const payload = { name, type: typeInput.value };
    if (state.newLocationGeo.lat != null) {
      payload.latitude = state.newLocationGeo.lat;
      payload.longitude = state.newLocationGeo.lng;
    }
    const { data, error } = await supabase
      .from("locations")
      .insert(payload)
      .select()
      .single();
    if (error) { console.error(error); toast("Não foi possível criar o local", true); return; }
    nameInput.value = "";
    state.newLocationGeo = { lat: null, lng: null };
    document.getElementById("new-location-geo-status").textContent = "";
    state.selectedLocation = data;
    showScreen("direction-select");
  });

  // -----------------------------------------------------------
  // Ecrã "Confirmar presença": câmara + GPS + hora
  // -----------------------------------------------------------
  let clockTimer = null;

  function enterConfirmScreen() {
    document.getElementById("confirm-employee").textContent = "👤 " + (state.selectedEmployee?.name || "—");
    document.getElementById("confirm-location").textContent = "📍 " + (state.selectedLocation?.name || "—");

    state.photoBlob = null;
    document.getElementById("captured-photo").hidden = true;
    document.getElementById("camera-video").hidden = false;
    document.getElementById("retake-photo-btn").hidden = true;
    document.getElementById("capture-btn").textContent = "Tirar foto e registar";
    document.getElementById("camera-msg").textContent = "";

    const dupEl = document.getElementById("duplicate-msg");
    if (state.duplicateWarning) {
      dupEl.textContent = "⚠️ " + state.duplicateWarning;
      dupEl.className = "geofence-msg geofence-msg--warn";
      dupEl.hidden = false;
    } else {
      dupEl.hidden = true;
    }

    const geoMsgEl = document.getElementById("geofence-msg");
    geoMsgEl.hidden = true;
    state.geofence = { distance: null, within: null };

    startCamera();
    startClock();
    requestGps();
  }

  function updateGeofenceMessage() {
    const el = document.getElementById("geofence-msg");
    const loc = state.selectedLocation;
    if (!loc || loc.latitude == null || loc.longitude == null || state.gps.status !== "ok") {
      el.hidden = true;
      state.geofence = { distance: null, within: null };
      return;
    }
    const dist = distanceMeters(state.gps.lat, state.gps.lng, loc.latitude, loc.longitude);
    const radius = loc.radius_m || 150;
    const within = dist <= radius;
    state.geofence = { distance: Math.round(dist), within };
    if (within) {
      el.textContent = `✅ Estás a ${Math.round(dist)}m de "${loc.name}" — dentro da área esperada.`;
      el.className = "geofence-msg geofence-msg--ok";
    } else {
      el.textContent = `⚠️ Estás a ${Math.round(dist)}m de "${loc.name}" — fora da área esperada (raio de ${radius}m). O registo será feito na mesma, mas fica assinalado.`;
      el.className = "geofence-msg geofence-msg--warn";
    }
    el.hidden = false;
  }

  function startClock() {
    const el = document.getElementById("confirm-time");
    const tick = () => {
      const now = new Date();
      const d = now.toLocaleDateString("pt-PT");
      const t = now.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
      el.textContent = "🕒 " + d + ", " + t;
    };
    tick();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000 * 15);
  }

  async function startCamera() {
    const video = document.getElementById("camera-video");
    const msg = document.getElementById("camera-msg");
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      video.srcObject = state.cameraStream;
      msg.textContent = "";
    } catch (err) {
      console.error(err);
      msg.textContent = "Sem acesso à câmara. Autoriza o acesso no navegador.";
    }
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }
    clearInterval(clockTimer);
  }

  function requestGps() {
    const el = document.getElementById("confirm-gps");
    state.gps = { status: "loading", lat: null, lng: null, accuracy: null };
    el.textContent = "📍 A obter localização…";
    el.className = "";

    if (!("geolocation" in navigator)) {
      state.gps.status = "sem_sinal";
      el.textContent = "📍 Sem sinal de GPS";
      el.className = "status-warn";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.gps = {
          status: "ok",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        el.textContent = `📍 Localização obtida (±${Math.round(pos.coords.accuracy)}m)`;
        el.className = "status-ok";
        updateGeofenceMessage();
      },
      (err) => {
        console.warn(err);
        state.gps.status = err.code === err.PERMISSION_DENIED ? "negado" : "sem_sinal";
        el.textContent = state.gps.status === "negado" ? "📍 Localização negada" : "📍 Sem sinal de GPS";
        el.className = "status-warn";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function capturePhotoFromVideo() {
    const video = document.getElementById("camera-video");
    const canvas = document.getElementById("camera-canvas");
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 960;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  }

  document.getElementById("capture-btn").addEventListener("click", async () => {
    const btn = document.getElementById("capture-btn");
    if (!state.photoBlob) {
      // primeiro clique: captura o frame e mostra pré-visualização
      if (!state.cameraStream) { toast("Ativa a câmara para continuar", true); return; }
      const blob = await capturePhotoFromVideo();
      state.photoBlob = blob;
      const img = document.getElementById("captured-photo");
      img.src = URL.createObjectURL(blob);
      img.hidden = false;
      document.getElementById("camera-video").hidden = true;
      document.getElementById("retake-photo-btn").hidden = false;
      btn.textContent = "Confirmar e registar presença";
      return;
    }
    // segundo clique: submete o registo
    await submitAttendance();
  });

  document.getElementById("retake-photo-btn").addEventListener("click", () => {
    state.photoBlob = null;
    document.getElementById("captured-photo").hidden = true;
    document.getElementById("camera-video").hidden = false;
    document.getElementById("retake-photo-btn").hidden = true;
    document.getElementById("capture-btn").textContent = "Tirar foto e registar";
  });

  async function submitAttendance() {
    const btn = document.getElementById("capture-btn");
    btn.disabled = true;
    btn.textContent = "A registar…";
    try {
      let photoPath = null;
      if (state.photoBlob) {
        const fileName = `${state.selectedLocation.id}/${state.selectedEmployee.id}/${Date.now()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from(cfg.STORAGE_BUCKET)
          .upload(fileName, state.photoBlob, { contentType: "image/jpeg" });
        if (upErr) throw upErr;
        photoPath = fileName;
      }

      const { error: insErr } = await supabase.from("attendance_records").insert({
        employee_id: state.selectedEmployee.id,
        location_id: state.selectedLocation.id,
        direction: state.direction,
        photo_path: photoPath,
        latitude: state.gps.lat,
        longitude: state.gps.lng,
        accuracy_m: state.gps.accuracy,
        gps_status: state.gps.status,
        distance_m: state.geofence.distance,
        within_geofence: state.geofence.within,
        device_time: new Date().toISOString(),
      });
      if (insErr) throw insErr;

      document.getElementById("success-summary").textContent =
        `${state.selectedEmployee.name} — ${state.direction === "entrada" ? "Entrada" : "Saída"} — ${state.selectedLocation.name}`;
      showScreen("success");
    } catch (err) {
      console.error(err);
      toast("Não foi possível registar a presença. Tenta novamente.", true);
    } finally {
      btn.disabled = false;
    }
  }

  // -----------------------------------------------------------
  // Gestão: login
  // -----------------------------------------------------------
  document.getElementById("admin-login-btn").addEventListener("click", async () => {
    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    const errEl = document.getElementById("admin-login-error");
    errEl.hidden = true;
    if (!email || !password) { errEl.textContent = "Preenche email e palavra-passe."; errEl.hidden = false; return; }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = "Credenciais inválidas.";
      errEl.hidden = false;
      return;
    }
    state.session = data.session;
    document.getElementById("admin-email").value = "";
    document.getElementById("admin-password").value = "";
    await fetchRole();
    showScreen("admin-dashboard");
  });

  document.getElementById("admin-logout-btn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    state.session = null;
    state.role = null;
    showScreen("home");
  });

  // -----------------------------------------------------------
  // Gestão: níveis de acesso (admin vs encarregado)
  // -----------------------------------------------------------
  async function fetchRole() {
    state.role = "encarregado";
    if (!state.session) return;
    try {
      const { data, error } = await supabase
        .from("admin_profiles")
        .select("role")
        .eq("id", state.session.user.id)
        .maybeSingle();
      if (!error && data) state.role = data.role;
    } catch (err) {
      console.error(err);
    }
    applyRoleUI();
  }

  function isAdmin() { return state.role === "admin"; }

  function applyRoleUI() {
    const badge = document.getElementById("role-badge");
    if (state.role) {
      badge.hidden = false;
      badge.textContent = isAdmin() ? "Administrador" : "Encarregado";
      badge.className = "role-badge " + (isAdmin() ? "role-badge--admin" : "role-badge--encarregado");
    } else {
      badge.hidden = true;
    }

    const adminOnly = [
      "admin-add-employee-row",
      "admin-add-location-row",
    ];
    adminOnly.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !isAdmin();
    });

    document.getElementById("export-xlsx-btn").hidden = false; // exportar é visível para ambos os níveis

    // Re-renderiza listas para mostrar/esconder ações de gestão
    if (state.dashboard.employees.length || state.dashboard.locations.length) {
      renderAdminEmployeeList();
      renderAdminLocationList();
    }
    renderRecordsList(state.dashboard.records || []);
  }

  // -----------------------------------------------------------
  // Gestão: tabs
  // -----------------------------------------------------------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("is-active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("is-active"));
      btn.classList.add("is-active");
      document.querySelector(`[data-tab-panel="${btn.dataset.tab}"]`).classList.add("is-active");
    });
  });

  // -----------------------------------------------------------
  // Gestão: dashboard de registos
  // -----------------------------------------------------------
  function publicPhotoUrl(path) {
    if (!path) return "";
    const { data } = supabase.storage.from(cfg.STORAGE_BUCKET).getPublicUrl(path);
    return data?.publicUrl || "";
  }

  async function loadDashboard() {
    if (!state.role) await fetchRole();

    const [{ data: employees }, { data: locations }] = await Promise.all([
      supabase.from("employees").select("*").order("name"),
      supabase.from("locations").select("*").order("name"),
    ]);
    state.dashboard.employees = employees || [];
    state.dashboard.locations = locations || [];

    fillSelect("filter-employee", state.dashboard.employees, "Todos os funcionários");
    fillSelect("filter-location", state.dashboard.locations, "Todos os locais");
    applyRoleUI();
    await loadRecords();
    await loadMonthlySummary();
  }

  function fillSelect(id, items, placeholder) {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      items.map((it) => `<option value="${it.id}">${escapeHtml(it.name)}</option>`).join("");
    sel.value = current;
  }

  async function loadRecords() {
    const box = document.getElementById("records-list");
    box.innerHTML = '<p class="list-empty">A carregar…</p>';

    let query = supabase
      .from("attendance_records")
      .select("*, employees(name, department), locations(name, type)")
      .order("created_at", { ascending: false })
      .limit(500);

    const empFilter = document.getElementById("filter-employee").value;
    const locFilter = document.getElementById("filter-location").value;
    const dateFilter = document.getElementById("filter-date").value;
    if (empFilter) query = query.eq("employee_id", empFilter);
    if (locFilter) query = query.eq("location_id", locFilter);
    if (dateFilter) {
      const start = new Date(dateFilter + "T00:00:00");
      const end = new Date(dateFilter + "T23:59:59");
      query = query.gte("created_at", start.toISOString()).lte("created_at", end.toISOString());
    }

    const { data, error } = await query;
    if (error) { console.error(error); box.innerHTML = '<p class="list-empty">Erro ao carregar registos.</p>'; return; }

    state.dashboard.records = data || [];
    renderRecordsList(state.dashboard.records);
  }

  function renderRecordsList(data) {
    const box = document.getElementById("records-list");
    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem registos para este filtro.</p>'; return; }

    box.innerHTML = "";
    data.forEach((rec) => {
      const when = new Date(rec.created_at).toLocaleString("pt-PT");
      const mapLink = (rec.latitude && rec.longitude)
        ? `<a href="https://maps.google.com/?q=${rec.latitude},${rec.longitude}" target="_blank" rel="noopener">Ver no mapa</a>`
        : "Sem localização";
      const geofenceTag = rec.within_geofence === false
        ? `<div class="r-line" style="color:var(--red);">⚠️ Fora da área (${Math.round(rec.distance_m || 0)}m)</div>`
        : "";
      const photo = rec.photo_path
        ? `<img class="record-thumb" src="${publicPhotoUrl(rec.photo_path)}" alt="" />`
        : `<div class="record-thumb"></div>`;
      const div = document.createElement("div");
      div.className = "record-card";
      div.innerHTML = `
        ${photo}
        <div class="record-info">
          <div class="r-name">${escapeHtml(rec.employees?.name || "—")}</div>
          <div class="r-line">${escapeHtml(rec.locations?.name || "—")} · ${when}</div>
          <div class="r-line">${mapLink}</div>
          ${geofenceTag}
        </div>
        <span class="record-badge ${rec.direction === "entrada" ? "record-badge--in" : "record-badge--out"}">
          ${rec.direction === "entrada" ? "Entrada" : "Saída"}
        </span>
        ${isAdmin() ? `
        <div class="record-actions">
          <button data-edit-record="${rec.id}">✏️ Editar</button>
          <button class="danger" data-delete-record="${rec.id}">🗑 Apagar</button>
        </div>` : ""}
      `;
      box.appendChild(div);
    });
  }

  document.getElementById("records-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit-record]");
    if (editBtn) { openEditRecordModal(editBtn.dataset.editRecord); return; }
    const delBtn = e.target.closest("[data-delete-record]");
    if (delBtn) { deleteRecord(delBtn.dataset.deleteRecord); return; }
  });

  // -----------------------------------------------------------
  // Gestão: editar / apagar registos (apenas admin)
  // -----------------------------------------------------------
  function openEditRecordModal(recordId) {
    const rec = state.dashboard.records.find((r) => r.id === recordId);
    if (!rec) return;
    state.editingRecordId = recordId;

    fillSelect("edit-record-employee", state.dashboard.employees, "—");
    fillSelect("edit-record-location", state.dashboard.locations, "—");
    document.getElementById("edit-record-employee").value = rec.employee_id;
    document.getElementById("edit-record-location").value = rec.location_id;
    document.getElementById("edit-record-direction").value = rec.direction;

    const dt = new Date(rec.created_at);
    const pad = (n) => String(n).padStart(2, "0");
    const localValue = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    document.getElementById("edit-record-datetime").value = localValue;

    document.getElementById("edit-record-modal").hidden = false;
  }

  document.getElementById("edit-record-cancel").addEventListener("click", () => {
    document.getElementById("edit-record-modal").hidden = true;
    state.editingRecordId = null;
  });

  document.getElementById("edit-record-save").addEventListener("click", async () => {
    if (!state.editingRecordId) return;
    const direction = document.getElementById("edit-record-direction").value;
    const employee_id = document.getElementById("edit-record-employee").value;
    const location_id = document.getElementById("edit-record-location").value;
    const dtValue = document.getElementById("edit-record-datetime").value;
    if (!dtValue) { toast("Indica a data e hora", true); return; }
    const created_at = new Date(dtValue).toISOString();

    const { error } = await supabase
      .from("attendance_records")
      .update({ direction, employee_id, location_id, created_at, device_time: created_at })
      .eq("id", state.editingRecordId);
    if (error) { console.error(error); toast("Não foi possível guardar a alteração", true); return; }

    document.getElementById("edit-record-modal").hidden = true;
    state.editingRecordId = null;
    toast("Registo atualizado");
    loadRecords();
  });

  async function deleteRecord(recordId) {
    if (!window.confirm("Apagar este registo de presença? Esta ação não pode ser desfeita.")) return;
    const { error } = await supabase.from("attendance_records").delete().eq("id", recordId);
    if (error) { console.error(error); toast("Não foi possível apagar o registo", true); return; }
    toast("Registo apagado");
    loadRecords();
  }

  ["filter-employee", "filter-location", "filter-date"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadRecords);
  });

  // -----------------------------------------------------------
  // Gestão: CRUD simples de funcionários e locais
  // -----------------------------------------------------------
  function renderAdminEmployeeList() {
    const box = document.getElementById("admin-employee-list");
    box.innerHTML = "";
    state.dashboard.employees.forEach((emp) => {
      const row = document.createElement("div");
      row.className = "list-item";
      const tag = isAdmin()
        ? `<span class="li-tag" data-role="toggle" style="cursor:pointer;">${emp.department || "—"} · ${emp.active ? "Desativar" : "Ativar"}</span>`
        : `<span class="li-tag">${emp.department || "—"}</span>`;
      row.innerHTML = `
        <span class="li-main">
          <span class="avatar">${initials(emp.name)}</span>
          <span class="li-name">${escapeHtml(emp.name)} ${emp.active ? "" : "(inativo)"}</span>
        </span>
        ${tag}
      `;
      const toggleEl = row.querySelector('[data-role="toggle"]');
      if (toggleEl) {
        toggleEl.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await supabase.from("employees").update({ active: !emp.active }).eq("id", emp.id);
          loadDashboard();
        });
      }
      box.appendChild(row);
    });
  }

  function renderAdminLocationList() {
    const box = document.getElementById("admin-location-list");
    box.innerHTML = "";
    state.dashboard.locations.forEach((loc) => {
      const row = document.createElement("div");
      row.className = "list-item";
      const tag = isAdmin()
        ? `<span class="li-tag" data-role="toggle" style="cursor:pointer;">${locationLabel(loc.type)} · ${loc.active ? "Desativar" : "Ativar"}</span>`
        : `<span class="li-tag">${locationLabel(loc.type)}</span>`;
      row.innerHTML = `
        <span class="li-main">
          <span class="avatar">${locationIcon(loc.type)}</span>
          <span class="li-name">${escapeHtml(loc.name)} ${loc.active ? "" : "(inativo)"}${loc.latitude != null ? " 📍" : ""}</span>
        </span>
        ${tag}
      `;
      const toggleEl = row.querySelector('[data-role="toggle"]');
      if (toggleEl) {
        toggleEl.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await supabase.from("locations").update({ active: !loc.active }).eq("id", loc.id);
          loadDashboard();
        });
      }
      box.appendChild(row);
    });
  }

  document.getElementById("admin-add-employee-btn").addEventListener("click", async () => {
    const nameInput = document.getElementById("admin-new-employee-name");
    const deptInput = document.getElementById("admin-new-employee-dept");
    const name = nameInput.value.trim();
    if (!name) return;
    const { error } = await supabase.from("employees").insert({ name, department: deptInput.value });
    if (error) { console.error(error); toast("Erro ao adicionar funcionário", true); return; }
    nameInput.value = "";
    loadDashboard();
  });

  document.getElementById("admin-new-location-geo-btn").addEventListener("click", () => {
    captureGeoInto("admin-new-location-geo-status", state.newLocationGeo);
  });

  document.getElementById("admin-add-location-btn").addEventListener("click", async () => {
    const nameInput = document.getElementById("admin-new-location-name");
    const typeInput = document.getElementById("admin-new-location-type");
    const name = nameInput.value.trim();
    if (!name) return;
    const payload = { name, type: typeInput.value };
    if (state.newLocationGeo.lat != null) {
      payload.latitude = state.newLocationGeo.lat;
      payload.longitude = state.newLocationGeo.lng;
    }
    const { error } = await supabase.from("locations").insert(payload);
    if (error) { console.error(error); toast("Erro ao adicionar local", true); return; }
    nameInput.value = "";
    state.newLocationGeo = { lat: null, lng: null };
    document.getElementById("admin-new-location-geo-status").textContent = "";
    loadDashboard();
  });

  // -----------------------------------------------------------
  // Gestão: exportar registos para Excel
  // -----------------------------------------------------------
  document.getElementById("export-xlsx-btn").addEventListener("click", () => {
    const rows = (state.dashboard.records || []).map((rec) => ({
      Funcionário: rec.employees?.name || "",
      Departamento: rec.employees?.department || "",
      Local: rec.locations?.name || "",
      Tipo: rec.locations?.type === "escritorio" ? "Escritório" : "Obra",
      Direção: rec.direction === "entrada" ? "Entrada" : "Saída",
      "Data/Hora": new Date(rec.created_at).toLocaleString("pt-PT"),
      Latitude: rec.latitude || "",
      Longitude: rec.longitude || "",
      "Distância (m)": rec.distance_m != null ? Math.round(rec.distance_m) : "",
      "Dentro da área": rec.within_geofence == null ? "" : (rec.within_geofence ? "Sim" : "Não"),
    }));
    if (!rows.length) { toast("Não há registos para exportar", true); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registos");
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `presencas-proqual-${stamp}.xlsx`);
  });

  // -----------------------------------------------------------
  // Gestão: resumo mensal por funcionário
  // -----------------------------------------------------------
  function defaultMonthValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  const resumoMonthInput = document.getElementById("resumo-month");
  if (!resumoMonthInput.value) resumoMonthInput.value = defaultMonthValue();
  resumoMonthInput.addEventListener("change", loadMonthlySummary);

  async function loadMonthlySummary() {
    const box = document.getElementById("resumo-list");
    const monthVal = resumoMonthInput.value || defaultMonthValue();
    box.innerHTML = '<p class="list-empty">A carregar…</p>';

    const [year, month] = monthVal.split("-").map(Number);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    const { data, error } = await supabase
      .from("attendance_records")
      .select("employee_id, direction, created_at, employees(name, department)")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (error) { console.error(error); box.innerHTML = '<p class="list-empty">Erro ao carregar o resumo.</p>'; return; }
    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem registos neste mês.</p>'; return; }

    // Agrupa por funcionário e emparelha entrada->saída cronologicamente
    const byEmployee = new Map();
    data.forEach((rec) => {
      if (!byEmployee.has(rec.employee_id)) {
        byEmployee.set(rec.employee_id, {
          name: rec.employees?.name || "—",
          department: rec.employees?.department || "—",
          records: [],
        });
      }
      byEmployee.get(rec.employee_id).records.push(rec);
    });

    const summaries = [];
    byEmployee.forEach((emp) => {
      let totalMs = 0;
      let openEntrada = null;
      const days = new Set();
      emp.records.forEach((rec) => {
        days.add(new Date(rec.created_at).toLocaleDateString("pt-PT"));
        if (rec.direction === "entrada") {
          openEntrada = new Date(rec.created_at);
        } else if (rec.direction === "saida" && openEntrada) {
          totalMs += new Date(rec.created_at) - openEntrada;
          openEntrada = null;
        }
      });
      summaries.push({
        name: emp.name,
        department: emp.department,
        hours: totalMs / 3600000,
        days: days.size,
        incomplete: !!openEntrada,
      });
    });

    summaries.sort((a, b) => a.name.localeCompare(b.name, "pt"));

    box.innerHTML = "";
    summaries.forEach((s) => {
      const div = document.createElement("div");
      div.className = "summary-card";
      div.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(s.name)}</div>
          <div class="s-sub">${escapeHtml(s.department)} · ${s.days} dia(s) com registo${s.incomplete ? " · ⚠️ tem uma entrada sem saída" : ""}</div>
        </div>
        <div class="s-hours">${s.hours.toFixed(1)}h<small>total no mês</small></div>
      `;
      box.appendChild(div);
    });
  }

  document.querySelector('[data-tab="resumo"]').addEventListener("click", loadMonthlySummary);

  // -----------------------------------------------------------
  // Utilitário
  // -----------------------------------------------------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // -----------------------------------------------------------
  // Arranque: se já houver sessão de Gestão ativa, mantém-se
  // -----------------------------------------------------------
  supabase.auth.getSession().then(({ data }) => {
    state.session = data.session;
    if (state.session) fetchRole();
  });

  showScreen("home");
})();
