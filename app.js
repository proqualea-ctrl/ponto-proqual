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
    dashboard: { records: [], employees: [], locations: [], absences: [], auditLog: [] },
    installPromptEvent: null,
    editingRecordId: null,
    flowMode: "presence", // 'presence' | 'absence' — decide o que acontece depois de escolher o funcionário
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
    if (name === "employee-select") {
      const title = document.getElementById("employee-select-title");
      if (title) title.textContent = state.flowMode === "absence" ? "QUEM PRECISA DE JUSTIFICAR?" : "QUEM ÉS TU?";
      renderEmployeeList();
    }
    if (name === "location-select") renderLocationList();
    if (name === "confirm-presence") enterConfirmScreen();
    if (name === "absence-new") enterAbsenceScreen();
    if (name === "admin-dashboard") loadDashboard();
  }

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      if (nav.dataset.flow) state.flowMode = nav.dataset.flow;
      showScreen(nav.dataset.nav);
      return;
    }
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

  const footerEl = document.getElementById("app-footer");
  if (footerEl) {
    const year = new Date().getFullYear();
    footerEl.textContent = `© ${year} ${cfg.COMPANY_NAME}` + (cfg.COMPANY_TAGLINE ? ` · ${cfg.COMPANY_TAGLINE}` : "");
  }

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
          showScreen(state.flowMode === "absence" ? "absence-new" : "location-select");
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
    showScreen(state.flowMode === "absence" ? "absence-new" : "location-select");
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

  function locationIcon(type) {
    if (type === "escritorio") return "🏢";
    if (type === "externo") return "🚗";
    return "🏗️";
  }
  function locationLabel(type) {
    if (type === "escritorio") return "Escritório";
    if (type === "externo") return "Serviço Externo";
    return "Obra";
  }

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

  function captureGeoInto(statusElId, onCapture) {
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
        onCapture(pos.coords.latitude, pos.coords.longitude);
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

  // Nota: criar locais novos ("+ Novo local") deixou de estar disponível
  // no ecrã do funcionário — só a Gestão pode criar obras/escritórios
  // (ver "admin-add-location-btn" mais abaixo). Isto está também reforçado
  // pela regra de segurança da base de dados (RLS): só utilizadores
  // autenticados podem inserir em "locations".

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

    document.getElementById("confirm-note").value = "";

    startCamera();
    startClock();
    requestGps();
  }

  function updateGeofenceMessage() {
    const el = document.getElementById("geofence-msg");
    const loc = state.selectedLocation;
    if (!loc || loc.type === "externo" || loc.latitude == null || loc.longitude == null || state.gps.status !== "ok") {
      el.hidden = true;
      state.geofence = { distance: null, within: null };
      return;
    }
    const dist = distanceMeters(state.gps.lat, state.gps.lng, loc.latitude, loc.longitude);
    const radius = loc.radius_m || 100;
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

      const isExterno = state.selectedLocation.type === "externo";
      const note = document.getElementById("confirm-note").value.trim();

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
        note: note || null,
        review_status: isExterno ? "pendente" : null,
        device_time: new Date().toISOString(),
      });
      if (insErr) throw insErr;

      document.getElementById("success-summary").textContent = isExterno
        ? `${state.selectedEmployee.name} — ${state.direction === "entrada" ? "Entrada" : "Saída"} — ${state.selectedLocation.name} (fica pendente de confirmação pela Gestão)`
        : `${state.selectedEmployee.name} — ${state.direction === "entrada" ? "Entrada" : "Saída"} — ${state.selectedLocation.name}`;
      showScreen("success");
    } catch (err) {
      console.error(err);
      toast("Não foi possível registar a presença. Tenta novamente.", true);
    } finally {
      btn.disabled = false;
    }
  }

  // -----------------------------------------------------------
  // Justificar falta: o funcionário pede, a Gestão aprova/rejeita
  // -----------------------------------------------------------
  function todayDateValue() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function enterAbsenceScreen() {
    document.getElementById("absence-employee").textContent = "👤 " + (state.selectedEmployee?.name || "—");
    document.getElementById("absence-date").value = todayDateValue();
    document.getElementById("absence-reason").value = "doenca";
    document.getElementById("absence-note").value = "";
    const photoInput = document.getElementById("absence-photo");
    photoInput.value = "";
    const preview = document.getElementById("absence-photo-preview");
    preview.hidden = true;
    preview.src = "";
  }

  function absenceReasonLabel(reason) {
    const labels = { doenca: "Doença", licenca: "Licença", pessoal: "Motivo pessoal", outro: "Outro" };
    return labels[reason] || "Outro";
  }

  document.getElementById("absence-photo").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    const preview = document.getElementById("absence-photo-preview");
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.hidden = true;
      preview.src = "";
    }
  });

  document.getElementById("absence-submit-btn").addEventListener("click", async () => {
    const btn = document.getElementById("absence-submit-btn");
    const dateInput = document.getElementById("absence-date");
    const reasonInput = document.getElementById("absence-reason");
    const noteInput = document.getElementById("absence-note");
    const photoFile = document.getElementById("absence-photo").files[0] || null;
    if (!dateInput.value) { toast("Indica a data da falta", true); return; }
    if (!state.selectedEmployee) { toast("Escolhe primeiro o funcionário", true); return; }

    btn.disabled = true;
    btn.textContent = "A enviar…";
    try {
      let photoPath = null;
      if (photoFile) {
        const safeName = photoFile.name.replace(/[^a-zA-Z0-9.]/g, "_");
        const fileName = `faltas/${state.selectedEmployee.id}/${Date.now()}-${safeName}`;
        const { error: upErr } = await supabase.storage
          .from(cfg.STORAGE_BUCKET)
          .upload(fileName, photoFile, { contentType: photoFile.type || "image/jpeg" });
        if (upErr) throw upErr;
        photoPath = fileName;
      }

      const { error } = await supabase.from("absence_requests").insert({
        employee_id: state.selectedEmployee.id,
        absence_date: dateInput.value,
        reason: reasonInput.value,
        note: noteInput.value.trim() || null,
        photo_path: photoPath,
      });
      if (error) throw error;

      const when = new Date(dateInput.value + "T00:00:00").toLocaleDateString("pt-PT");
      document.getElementById("success-summary").textContent =
        `${state.selectedEmployee.name} — falta de ${when} (${absenceReasonLabel(reasonInput.value)}) enviada para aprovação da Gestão`;
      showScreen("success");
    } catch (err) {
      console.error(err);
      toast("Não foi possível enviar o pedido. Tenta novamente.", true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  });

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
    state.actorName = null;
    if (!state.session) return;
    try {
      const { data, error } = await supabase
        .from("admin_profiles")
        .select("role, full_name")
        .eq("id", state.session.user.id)
        .maybeSingle();
      if (!error && data) {
        state.role = data.role;
        state.actorName = data.full_name || null;
      }
    } catch (err) {
      console.error(err);
    }
    applyRoleUI();
  }

  function isAdmin() { return state.role === "admin"; }

  // -----------------------------------------------------------
  // Gestão: registo de alterações (auditoria) — quem editou/apagou/
  // aprovou/rejeitou o quê e quando. Tabela append-only (sem update
  // nem delete no schema), para servir de histórico de confiança.
  // -----------------------------------------------------------
  function actorLabel() {
    return state.actorName || state.session?.user?.email || "Gestão";
  }

  async function logAudit(action, entityType, entityId, entityLabel) {
    try {
      const { error } = await supabase.from("audit_log").insert({
        actor_email: state.session?.user?.email || null,
        actor_name: state.actorName || null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        entity_label: entityLabel || null,
      });
      if (error) { console.error("audit log:", error); return; }
      loadAuditLog(); // mantém a tab "Histórico" sempre atualizada
    } catch (err) {
      console.error("audit log:", err);
    }
  }

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
    renderAbsenceList(state.dashboard.absences || []);
    renderAuditList(state.dashboard.auditLog || []);
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
    await loadAbsenceRequests();
    await loadAuditLog();
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
        ? `📍 ${rec.latitude.toFixed(5)}, ${rec.longitude.toFixed(5)}${rec.accuracy_m ? ` (±${Math.round(rec.accuracy_m)}m)` : ""} · <a href="https://maps.google.com/?q=${rec.latitude},${rec.longitude}" target="_blank" rel="noopener">Ver no mapa</a>`
        : "Sem localização";
      const geofenceTag = rec.within_geofence === false
        ? `<div class="r-line" style="color:var(--red);">⚠️ Fora da área (${Math.round(rec.distance_m || 0)}m)</div>`
        : "";
      const noteTag = rec.note
        ? `<div class="r-line">📝 ${escapeHtml(rec.note)}</div>`
        : "";
      const reviewBadges = {
        pendente: `<span class="review-badge review-badge--pendente">⏳ Pendente</span>`,
        aprovado: `<span class="review-badge review-badge--aprovado">✅ Aprovado</span>`,
        rejeitado: `<span class="review-badge review-badge--rejeitado">❌ Rejeitado</span>`,
      };
      const reviewTag = rec.review_status ? `<div class="r-line">${reviewBadges[rec.review_status] || ""}</div>` : "";
      const reviewedByTag = (rec.review_status && rec.review_status !== "pendente" && rec.reviewed_by)
        ? `<div class="r-line audit-line">${rec.review_status === "aprovado" ? "Aprovado" : "Rejeitado"} por ${escapeHtml(rec.reviewed_by)} em ${new Date(rec.reviewed_at).toLocaleString("pt-PT")}</div>`
        : "";
      const updatedTag = rec.updated_by
        ? `<div class="r-line audit-line">✏️ Editado por ${escapeHtml(rec.updated_by)} em ${new Date(rec.updated_at).toLocaleString("pt-PT")}</div>`
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
          ${noteTag}
          ${reviewTag}
          ${reviewedByTag}
          ${updatedTag}
        </div>
        <span class="record-badge ${rec.direction === "entrada" ? "record-badge--in" : "record-badge--out"}">
          ${rec.direction === "entrada" ? "Entrada" : "Saída"}
        </span>
        ${isAdmin() ? `
        <div class="record-actions">
          ${rec.review_status === "pendente" ? `
          <button class="approve" data-approve-record="${rec.id}">✅ Aprovar</button>
          <button class="danger" data-reject-record="${rec.id}">❌ Rejeitar</button>` : ""}
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
    const approveBtn = e.target.closest("[data-approve-record]");
    if (approveBtn) { setReviewStatus(approveBtn.dataset.approveRecord, "aprovado"); return; }
    const rejectBtn = e.target.closest("[data-reject-record]");
    if (rejectBtn) { setReviewStatus(rejectBtn.dataset.rejectRecord, "rejeitado"); return; }
  });

  async function setReviewStatus(recordId, status) {
    const rec = state.dashboard.records.find((r) => r.id === recordId);
    const { error } = await supabase
      .from("attendance_records")
      .update({ review_status: status, reviewed_by: actorLabel(), reviewed_at: new Date().toISOString() })
      .eq("id", recordId);
    if (error) { console.error(error); toast("Não foi possível atualizar o estado", true); return; }
    logAudit(
      status === "aprovado" ? "aprovar" : "rejeitar",
      "presenca",
      recordId,
      rec ? `${rec.employees?.name || "—"} — ${rec.locations?.name || "—"}` : null
    );
    toast(status === "aprovado" ? "Registo aprovado" : "Registo rejeitado");
    loadRecords();
  }

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
      .update({ direction, employee_id, location_id, created_at, device_time: created_at, updated_by: actorLabel(), updated_at: new Date().toISOString() })
      .eq("id", state.editingRecordId);
    if (error) { console.error(error); toast("Não foi possível guardar a alteração", true); return; }

    const editedEmp = state.dashboard.employees.find((e) => e.id === employee_id);
    logAudit("editar", "presenca", state.editingRecordId, editedEmp ? editedEmp.name : null);

    document.getElementById("edit-record-modal").hidden = true;
    state.editingRecordId = null;
    toast("Registo atualizado");
    loadRecords();
  });

  async function deleteRecord(recordId) {
    if (!window.confirm("Apagar este registo de presença? Esta ação não pode ser desfeita.")) return;
    const rec = state.dashboard.records.find((r) => r.id === recordId);
    const { error } = await supabase.from("attendance_records").delete().eq("id", recordId);
    if (error) { console.error(error); toast("Não foi possível apagar o registo", true); return; }
    logAudit(
      "apagar",
      "presenca",
      recordId,
      rec ? `${rec.employees?.name || "—"} — ${new Date(rec.created_at).toLocaleString("pt-PT")}` : null
    );
    toast("Registo apagado");
    loadRecords();
  }

  ["filter-employee", "filter-location", "filter-date"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadRecords);
  });

  // -----------------------------------------------------------
  // Gestão: pedidos de justificação de falta
  // -----------------------------------------------------------
  async function loadAbsenceRequests() {
    const box = document.getElementById("absence-list");
    if (box) box.innerHTML = '<p class="list-empty">A carregar…</p>';

    const { data, error } = await supabase
      .from("absence_requests")
      .select("*, employees(name, department)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) { console.error(error); if (box) box.innerHTML = '<p class="list-empty">Erro ao carregar faltas.</p>'; return; }

    state.dashboard.absences = data || [];
    renderAbsenceList(state.dashboard.absences);
  }

  function renderAbsenceList(data) {
    const box = document.getElementById("absence-list");
    if (!box) return;

    const tabBtn = document.querySelector('[data-tab="faltas"]');
    if (tabBtn) {
      const pending = data.filter((r) => r.status === "pendente").length;
      tabBtn.textContent = pending ? `Faltas (${pending})` : "Faltas";
    }

    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem pedidos de justificação de falta.</p>'; return; }

    const statusBadges = {
      pendente: `<span class="review-badge review-badge--pendente">⏳ Pendente</span>`,
      aprovado: `<span class="review-badge review-badge--aprovado">✅ Aprovado</span>`,
      rejeitado: `<span class="review-badge review-badge--rejeitado">❌ Rejeitado</span>`,
    };

    box.innerHTML = "";
    data.forEach((req) => {
      const when = new Date(req.absence_date + "T00:00:00").toLocaleDateString("pt-PT");
      const noteTag = req.note ? `<div class="r-line">📝 ${escapeHtml(req.note)}</div>` : "";
      const reviewedByTag = (req.status !== "pendente" && req.reviewed_by)
        ? `<div class="r-line audit-line">${req.status === "aprovado" ? "Aprovado" : "Rejeitado"} por ${escapeHtml(req.reviewed_by)} em ${new Date(req.reviewed_at).toLocaleString("pt-PT")}</div>`
        : "";
      const photo = req.photo_path
        ? `<a href="${publicPhotoUrl(req.photo_path)}" target="_blank" rel="noopener"><img class="record-thumb" src="${publicPhotoUrl(req.photo_path)}" alt="" /></a>`
        : `<div class="record-thumb"></div>`;
      const div = document.createElement("div");
      div.className = "record-card";
      div.innerHTML = `
        ${photo}
        <div class="record-info">
          <div class="r-name">${escapeHtml(req.employees?.name || "—")}</div>
          <div class="r-line">📅 ${when} · ${absenceReasonLabel(req.reason)}</div>
          ${noteTag}
          <div class="r-line">${statusBadges[req.status] || ""}</div>
          ${reviewedByTag}
        </div>
        ${isAdmin() ? `
        <div class="record-actions">
          ${req.status === "pendente" ? `
          <button class="approve" data-approve-absence="${req.id}">✅ Aprovar</button>
          <button class="danger" data-reject-absence="${req.id}">❌ Rejeitar</button>` : ""}
          <button class="danger" data-delete-absence="${req.id}">🗑 Apagar</button>
        </div>` : ""}
      `;
      box.appendChild(div);
    });
  }

  document.getElementById("absence-list").addEventListener("click", (e) => {
    const approveBtn = e.target.closest("[data-approve-absence]");
    if (approveBtn) { setAbsenceStatus(approveBtn.dataset.approveAbsence, "aprovado"); return; }
    const rejectBtn = e.target.closest("[data-reject-absence]");
    if (rejectBtn) { setAbsenceStatus(rejectBtn.dataset.rejectAbsence, "rejeitado"); return; }
    const delBtn = e.target.closest("[data-delete-absence]");
    if (delBtn) { deleteAbsence(delBtn.dataset.deleteAbsence); return; }
  });

  async function setAbsenceStatus(requestId, status) {
    const req = state.dashboard.absences.find((r) => r.id === requestId);
    const { error } = await supabase
      .from("absence_requests")
      .update({ status, reviewed_by: actorLabel(), reviewed_at: new Date().toISOString() })
      .eq("id", requestId);
    if (error) { console.error(error); toast("Não foi possível atualizar o pedido", true); return; }
    logAudit(
      status === "aprovado" ? "aprovar" : "rejeitar",
      "falta",
      requestId,
      req ? `${req.employees?.name || "—"} — ${req.absence_date}` : null
    );
    toast(status === "aprovado" ? "Falta aprovada" : "Falta rejeitada");
    loadAbsenceRequests();
  }

  async function deleteAbsence(requestId) {
    if (!window.confirm("Apagar este pedido de justificação de falta?")) return;
    const req = state.dashboard.absences.find((r) => r.id === requestId);
    const { error } = await supabase.from("absence_requests").delete().eq("id", requestId);
    if (error) { console.error(error); toast("Não foi possível apagar o pedido", true); return; }
    logAudit("apagar", "falta", requestId, req ? `${req.employees?.name || "—"} — ${req.absence_date}` : null);
    toast("Pedido apagado");
    loadAbsenceRequests();
  }

  // -----------------------------------------------------------
  // Gestão: histórico de alterações (tab "Histórico")
  // -----------------------------------------------------------
  const auditActionLabels = { editar: "✏️ Editou", apagar: "🗑 Apagou", aprovar: "✅ Aprovou", rejeitar: "❌ Rejeitou" };
  const auditEntityLabels = { presenca: "um registo de presença", falta: "um pedido de falta" };

  async function loadAuditLog() {
    const box = document.getElementById("audit-list");
    if (box) box.innerHTML = '<p class="list-empty">A carregar…</p>';

    const { data, error } = await supabase
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) { console.error(error); if (box) box.innerHTML = '<p class="list-empty">Erro ao carregar o histórico.</p>'; return; }

    state.dashboard.auditLog = data || [];
    renderAuditList(state.dashboard.auditLog);
  }

  function renderAuditList(data) {
    const box = document.getElementById("audit-list");
    if (!box) return;
    if (!data.length) { box.innerHTML = '<p class="list-empty">Ainda não há alterações registadas.</p>'; return; }

    box.innerHTML = "";
    data.forEach((entry) => {
      const when = new Date(entry.created_at).toLocaleString("pt-PT");
      const div = document.createElement("div");
      div.className = "record-card";
      div.innerHTML = `
        <div class="record-info">
          <div class="r-name">${auditActionLabels[entry.action] || entry.action} ${auditEntityLabels[entry.entity_type] || ""}</div>
          <div class="r-line">${escapeHtml(entry.entity_label || "—")}</div>
          <div class="r-line">👤 ${escapeHtml(entry.actor_name || entry.actor_email || "Gestão")} · ${when}</div>
        </div>
      `;
      box.appendChild(div);
    });
  }

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
    captureGeoInto("admin-new-location-geo-status", (lat, lng) => {
      document.getElementById("admin-new-location-lat").value = lat.toFixed(6);
      document.getElementById("admin-new-location-lng").value = lng.toFixed(6);
    });
  });

  document.getElementById("admin-add-location-btn").addEventListener("click", async () => {
    const nameInput = document.getElementById("admin-new-location-name");
    const typeInput = document.getElementById("admin-new-location-type");
    const latInput = document.getElementById("admin-new-location-lat");
    const lngInput = document.getElementById("admin-new-location-lng");
    const radiusInput = document.getElementById("admin-new-location-radius");
    const name = nameInput.value.trim();
    if (!name) return;

    const payload = { name, type: typeInput.value };
    const lat = parseFloat(latInput.value.replace(",", "."));
    const lng = parseFloat(lngInput.value.replace(",", "."));
    if (!isNaN(lat) && !isNaN(lng)) {
      payload.latitude = lat;
      payload.longitude = lng;
      const radius = parseInt(radiusInput.value, 10);
      payload.radius_m = !isNaN(radius) && radius > 0 ? radius : 100;
    } else if (latInput.value.trim() || lngInput.value.trim()) {
      toast("Latitude/Longitude inválidas — deixa ambas em branco ou preenche as duas", true);
      return;
    }

    const { error } = await supabase.from("locations").insert(payload);
    if (error) { console.error(error); toast("Erro ao adicionar local", true); return; }
    nameInput.value = "";
    latInput.value = "";
    lngInput.value = "";
    radiusInput.value = "100";
    document.getElementById("admin-new-location-geo-status").textContent = "";
    toast(payload.latitude != null ? "Local adicionado com localização definida" : "Local adicionado (sem coordenadas — podes adicionar mais tarde)");
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
      Tipo: locationLabel(rec.locations?.type),
      Direção: rec.direction === "entrada" ? "Entrada" : "Saída",
      "Data/Hora": new Date(rec.created_at).toLocaleString("pt-PT"),
      Latitude: rec.latitude || "",
      Longitude: rec.longitude || "",
      "Distância (m)": rec.distance_m != null ? Math.round(rec.distance_m) : "",
      "Dentro da área": rec.within_geofence == null ? "" : (rec.within_geofence ? "Sim" : "Não"),
      Nota: rec.note || "",
      Estado: rec.review_status ? rec.review_status.charAt(0).toUpperCase() + rec.review_status.slice(1) : "",
    }));
    if (!rows.length) { toast("Não há registos para exportar", true); return; }

    // Cabeçalho oficial (identidade da empresa) antes da tabela de dados —
    // NUIT/morada só aparecem se estiverem preenchidos em config.js.
    const now = new Date();
    const headerLines = [[cfg.COMPANY_NAME || "PROQUAL Engenheiros e Associados, Lda"]];
    if (cfg.COMPANY_TAGLINE) headerLines.push([cfg.COMPANY_TAGLINE]);
    if (cfg.COMPANY_NUIT) headerLines.push([`NUIT: ${cfg.COMPANY_NUIT}`]);
    if (cfg.COMPANY_ADDRESS) headerLines.push([cfg.COMPANY_ADDRESS]);
    headerLines.push(["Relatório de Registos de Presença"]);
    headerLines.push([`Documento gerado automaticamente pelo sistema ${cfg.APP_TITLE} em ${now.toLocaleString("pt-PT")}`]);
    headerLines.push([]); // linha em branco antes da tabela

    const columns = Object.keys(rows[0]);
    const aoa = [...headerLines, columns, ...rows.map((r) => columns.map((c) => r[c]))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registos");
    const stamp = now.toISOString().slice(0, 10);
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
      .select("employee_id, direction, created_at, review_status, employees(name, department)")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (error) { console.error(error); box.innerHTML = '<p class="list-empty">Erro ao carregar o resumo.</p>'; return; }
    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem registos neste mês.</p>'; return; }

    // Registos de "Serviço Externo" rejeitados pela Gestão não contam
    // para as horas trabalhadas (a presença não foi confirmada).
    const validData = data.filter((rec) => rec.review_status !== "rejeitado");
    if (!validData.length) { box.innerHTML = '<p class="list-empty">Sem registos válidos neste mês.</p>'; return; }

    // Agrupa por funcionário e emparelha entrada->saída cronologicamente
    const byEmployee = new Map();
    validData.forEach((rec) => {
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
