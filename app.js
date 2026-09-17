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
    editingLocationId: null,
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
    if (name === "admin-forgot") {
      const errEl = document.getElementById("forgot-error");
      const okEl = document.getElementById("forgot-success");
      if (errEl) errEl.hidden = true;
      if (okEl) okEl.hidden = true;
    }
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

  function formatTasksSummary(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) return "";
    return tasks.map((t) => `${t.description}${t.percent ? ` (${t.percent}%)` : ""}`).join(", ");
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

    document.getElementById("tasks-section").hidden = true;
    document.getElementById("tasks-list").innerHTML = "";
    updateTasksTotal();

    startCamera();
    startClock();
    requestGps();
  }

  // -----------------------------------------------------------
  // Tarefas realizadas no turno (só aparece na Saída, depois da
  // foto ser tirada, e antes de confirmar/fechar o registo).
  // -----------------------------------------------------------
  function createTaskRow(desc, percent) {
    const row = document.createElement("div");
    row.className = "task-row";
    row.innerHTML = `
      <input class="text-input task-desc" type="text" placeholder="Descrição da tarefa" data-task-desc autocomplete="off" />
      <input class="text-input task-percent" type="number" min="0" max="100" placeholder="%" data-task-percent />
      <button class="task-remove-btn" type="button" data-task-remove aria-label="Remover tarefa">×</button>
    `;
    row.querySelector("[data-task-desc]").value = desc || "";
    row.querySelector("[data-task-percent]").value = percent || "";
    row.querySelector("[data-task-percent]").addEventListener("input", updateTasksTotal);
    row.querySelector("[data-task-remove]").addEventListener("click", () => {
      row.remove();
      updateTasksTotal();
    });
    return row;
  }

  function updateTasksTotal() {
    const percentInputs = document.querySelectorAll("#tasks-list [data-task-percent]");
    const el = document.getElementById("tasks-total");
    if (!percentInputs.length) { el.textContent = ""; el.className = "tasks-total"; return; }
    let total = 0;
    percentInputs.forEach((inp) => { total += Number(inp.value) || 0; });
    if (total === 100) {
      el.textContent = "Total: 100% ✅";
      el.className = "tasks-total tasks-total--ok";
    } else if (total > 100) {
      el.textContent = `Total: ${total}% — excede 100%`;
      el.className = "tasks-total tasks-total--warn";
    } else {
      el.textContent = `Total: ${total}% — falta ${100 - total}% (opcional, mas ajuda a Gestão)`;
      el.className = "tasks-total tasks-total--warn";
    }
  }

  document.getElementById("tasks-add-btn").addEventListener("click", () => {
    const row = createTaskRow("", "");
    document.getElementById("tasks-list").appendChild(row);
    row.querySelector("[data-task-desc]").focus();
    updateTasksTotal();
  });

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
      // Só depois de a foto estar tirada — e só na Saída — é que pedimos
      // a descrição das tarefas realizadas, antes de fechar o registo.
      if (state.direction === "saida") {
        const tasksSection = document.getElementById("tasks-section");
        tasksSection.hidden = false;
        if (!document.getElementById("tasks-list").children.length) {
          document.getElementById("tasks-list").appendChild(createTaskRow("", ""));
        }
        updateTasksTotal();
      }
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
    document.getElementById("tasks-section").hidden = true;
  });

  async function submitAttendance() {
    const btn = document.getElementById("capture-btn");

    let tasks = null;
    if (state.direction === "saida") {
      const rows = [...document.querySelectorAll("#tasks-list .task-row")];
      tasks = rows
        .map((row) => ({
          description: row.querySelector("[data-task-desc]").value.trim(),
          percent: Number(row.querySelector("[data-task-percent]").value) || 0,
        }))
        .filter((t) => t.description);
      if (!tasks.length) {
        toast("Descreve pelo menos uma tarefa antes de confirmar a saída", true);
        return;
      }
    }

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
        tasks: tasks,
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

  // -----------------------------------------------------------
  // Gestão: "Esqueci a palavra-passe" (recuperação por email)
  // -----------------------------------------------------------
  document.getElementById("forgot-send-btn").addEventListener("click", async () => {
    const btn = document.getElementById("forgot-send-btn");
    const email = document.getElementById("forgot-email").value.trim();
    const errEl = document.getElementById("forgot-error");
    const okEl = document.getElementById("forgot-success");
    errEl.hidden = true;
    okEl.hidden = true;

    if (!email) { errEl.textContent = "Indica o teu email."; errEl.hidden = false; return; }

    btn.disabled = true;
    btn.textContent = "A enviar…";
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      // Por segurança, mostramos sempre a mesma mensagem de sucesso,
      // exista ou não uma conta com esse email — assim ninguém consegue
      // usar este formulário para descobrir que emails têm conta na Gestão.
      if (error && error.status && error.status >= 500) {
        errEl.textContent = "Não foi possível enviar o pedido agora. Tenta novamente.";
        errEl.hidden = false;
      } else {
        document.getElementById("forgot-email").value = "";
        okEl.textContent = "Se existir uma conta com esse email, foi enviado um link de recuperação. Verifica a caixa de entrada (e o spam).";
        okEl.hidden = false;
      }
    } catch (err) {
      console.error(err);
      errEl.textContent = "Não foi possível enviar o pedido agora. Tenta novamente.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar link de recuperação";
    }
  });

  // Quando a pessoa abre o link de recuperação recebido por email, o
  // Supabase dispara este evento assim que a página carrega — mostramos
  // o ecrã para escolher a nova palavra-passe.
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      state.session = session;
      showScreen("admin-reset-password");
    }
  });

  document.getElementById("reset-submit-btn").addEventListener("click", async () => {
    const btn = document.getElementById("reset-submit-btn");
    const errEl = document.getElementById("reset-error");
    errEl.hidden = true;

    const newPassword = document.getElementById("reset-new-password").value;
    const confirmPassword = document.getElementById("reset-confirm-password").value;

    if (!newPassword || !confirmPassword) {
      errEl.textContent = "Preenche os dois campos.";
      errEl.hidden = false;
      return;
    }
    if (newPassword.length < 8) {
      errEl.textContent = "A nova palavra-passe deve ter pelo menos 8 caracteres.";
      errEl.hidden = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = "A confirmação não coincide com a nova palavra-passe.";
      errEl.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = "A guardar…";
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        errEl.textContent = "Não foi possível guardar a nova palavra-passe. Pede um novo link de recuperação.";
        errEl.hidden = false;
        return;
      }
      document.getElementById("reset-new-password").value = "";
      document.getElementById("reset-confirm-password").value = "";
      toast("Palavra-passe definida com sucesso");
      logAudit("seguranca", "conta", state.session?.user?.id, state.session?.user?.email || null);
      await fetchRole();
      showScreen("admin-dashboard");
    } catch (err) {
      console.error(err);
      errEl.textContent = "Erro inesperado. Tenta novamente.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar nova palavra-passe";
    }
  });

  document.getElementById("admin-logout-btn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    state.session = null;
    state.role = null;
    ["conta-current-password", "conta-new-password", "conta-confirm-password"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    ["conta-password-error", "conta-password-success"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    showScreen("home");
  });

  // -----------------------------------------------------------
  // Gestão: alterar a própria palavra-passe (tab "Conta")
  // -----------------------------------------------------------
  document.getElementById("conta-change-password-btn").addEventListener("click", async () => {
    const btn = document.getElementById("conta-change-password-btn");
    const errEl = document.getElementById("conta-password-error");
    const okEl = document.getElementById("conta-password-success");
    errEl.hidden = true;
    okEl.hidden = true;

    const currentPassword = document.getElementById("conta-current-password").value;
    const newPassword = document.getElementById("conta-new-password").value;
    const confirmPassword = document.getElementById("conta-confirm-password").value;
    const email = state.session?.user?.email;

    if (!email) { errEl.textContent = "Sessão inválida — volta a entrar."; errEl.hidden = false; return; }
    if (!currentPassword || !newPassword || !confirmPassword) {
      errEl.textContent = "Preenche os três campos.";
      errEl.hidden = false;
      return;
    }
    if (newPassword.length < 8) {
      errEl.textContent = "A nova palavra-passe deve ter pelo menos 8 caracteres.";
      errEl.hidden = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = "A confirmação não coincide com a nova palavra-passe.";
      errEl.hidden = false;
      return;
    }
    if (newPassword === currentPassword) {
      errEl.textContent = "A nova palavra-passe tem de ser diferente da atual.";
      errEl.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = "A verificar…";
    try {
      // Confirma a palavra-passe atual antes de trocar — mesmo com a
      // sessão já iniciada, isto evita que alguém troque a password a
      // partir de uma sessão esquecida aberta sem saber a atual.
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
      if (verifyError) {
        errEl.textContent = "Palavra-passe atual incorreta.";
        errEl.hidden = false;
        return;
      }

      btn.textContent = "A alterar…";
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        errEl.textContent = "Não foi possível alterar a palavra-passe. Tenta novamente.";
        errEl.hidden = false;
        return;
      }

      document.getElementById("conta-current-password").value = "";
      document.getElementById("conta-new-password").value = "";
      document.getElementById("conta-confirm-password").value = "";
      okEl.textContent = "Palavra-passe alterada com sucesso.";
      okEl.hidden = false;
      toast("Palavra-passe alterada");
      logAudit("seguranca", "conta", state.session?.user?.id, email);
    } catch (err) {
      console.error(err);
      errEl.textContent = "Erro inesperado. Tenta novamente.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Alterar palavra-passe";
    }
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
    const contaEmailEl = document.getElementById("conta-email");
    if (contaEmailEl) contaEmailEl.textContent = state.session?.user?.email || "—";

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
      "export-backup-btn",
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
  // O bucket de fotos é privado — para mostrar uma foto na Gestão é
  // preciso pedir um link temporário (signed URL), válido por 1 hora,
  // em vez do link público antigo. signedPhotoUrlMap() faz isso para
  // uma lista inteira de registos de uma só vez, antes de desenhar a
  // lista (para não haver um pedido de rede por cada `<img>`).
  async function signedPhotoUrlMap(paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    const map = new Map();
    await Promise.all(unique.map(async (path) => {
      try {
        const { data, error } = await supabase.storage.from(cfg.STORAGE_BUCKET).createSignedUrl(path, 3600);
        if (!error && data?.signedUrl) map.set(path, data.signedUrl);
      } catch (err) {
        console.error("signed url:", err);
      }
    }));
    return map;
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
    fillSelect("individual-employee-select", state.dashboard.employees, "Escolher funcionário…");
    applyRoleUI();
    await loadRecords();
    await loadAbsenceRequests();
    await loadAuditLog();
    await loadMonthlySummary();
    await loadNowWorking();
  }

  // -----------------------------------------------------------
  // Gestão: "Agora" — quem tem uma Entrada marcada hoje e ainda não
  // marcou a Saída correspondente (o último registo do dia, por
  // funcionário, é uma Entrada).
  // -----------------------------------------------------------
  async function loadNowWorking() {
    const box = document.getElementById("now-working-list");
    if (!box) return;
    box.innerHTML = '<p class="list-empty">A carregar…</p>';

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const { data, error } = await supabase
      .from("attendance_records")
      .select("employee_id, direction, created_at, employees(name), locations(name)")
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (error) {
      console.error(error);
      box.innerHTML = '<p class="list-empty">Erro ao carregar.</p>';
      return;
    }

    // O registo mais recente do dia, por funcionário — como a consulta
    // já vem ordenada do mais antigo para o mais recente, o último
    // "set" de cada funcionário no Map fica sempre com o mais recente.
    const lastByEmployee = new Map();
    (data || []).forEach((rec) => { lastByEmployee.set(rec.employee_id, rec); });

    const working = [...lastByEmployee.values()].filter((rec) => rec.direction === "entrada");
    renderNowWorkingList(working);
  }

  function renderNowWorkingList(working) {
    const box = document.getElementById("now-working-list");
    const countEl = document.getElementById("now-working-count");
    if (!box) return;

    if (countEl) {
      countEl.textContent = working.length
        ? `🟢 ${working.length} em serviço agora`
        : "Ninguém em serviço neste momento";
    }

    if (!working.length) {
      box.innerHTML = '<p class="list-empty">Ninguém tem uma Entrada em aberto hoje.</p>';
      return;
    }

    const byLocation = new Map();
    working.forEach((rec) => {
      const locName = rec.locations?.name || "Local desconhecido";
      if (!byLocation.has(locName)) byLocation.set(locName, []);
      byLocation.get(locName).push(rec);
    });

    box.innerHTML = "";
    [...byLocation.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "pt-PT"))
      .forEach(([locName, recs]) => {
        const head = document.createElement("p");
        head.className = "muted";
        head.style.cssText = "font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:0.4px; margin:14px 0 6px;";
        head.textContent = `📍 ${locName} · ${recs.length}`;
        box.appendChild(head);

        recs
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .forEach((rec) => {
            const since = new Date(rec.created_at).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
            const row = document.createElement("div");
            row.className = "list-item";
            row.style.cursor = "default";
            row.innerHTML = `
              <span class="li-main">
                <span class="avatar">${initials(rec.employees?.name || "—")}</span>
                <span class="li-name">${escapeHtml(rec.employees?.name || "—")}</span>
              </span>
              <span class="li-tag">🟢 desde ${since}</span>
            `;
            box.appendChild(row);
          });
      });
  }

  document.getElementById("now-working-refresh-btn").addEventListener("click", loadNowWorking);

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

  async function renderRecordsList(data) {
    const box = document.getElementById("records-list");
    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem registos para este filtro.</p>'; return; }

    const photoUrls = await signedPhotoUrlMap(data.map((rec) => rec.photo_path));

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
      const tasksTag = (rec.direction === "saida" && Array.isArray(rec.tasks) && rec.tasks.length)
        ? `<div class="r-line">🛠️ ${escapeHtml(formatTasksSummary(rec.tasks))}</div>`
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
        ? `<img class="record-thumb" src="${escapeHtml(photoUrls.get(rec.photo_path) || "")}" alt="" />`
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
          ${tasksTag}
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

  async function renderAbsenceList(data) {
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

    const photoUrls = await signedPhotoUrlMap(data.map((req) => req.photo_path));

    box.innerHTML = "";
    data.forEach((req) => {
      const when = new Date(req.absence_date + "T00:00:00").toLocaleDateString("pt-PT");
      const noteTag = req.note ? `<div class="r-line">📝 ${escapeHtml(req.note)}</div>` : "";
      const reviewedByTag = (req.status !== "pendente" && req.reviewed_by)
        ? `<div class="r-line audit-line">${req.status === "aprovado" ? "Aprovado" : "Rejeitado"} por ${escapeHtml(req.reviewed_by)} em ${new Date(req.reviewed_at).toLocaleString("pt-PT")}</div>`
        : "";
      const photoUrl = escapeHtml(photoUrls.get(req.photo_path) || "");
      const photo = req.photo_path
        ? `<a href="${photoUrl}" target="_blank" rel="noopener"><img class="record-thumb" src="${photoUrl}" alt="" /></a>`
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
  const auditActionLabels = { editar: "✏️ Editou", apagar: "🗑 Apagou", aprovar: "✅ Aprovou", rejeitar: "❌ Rejeitou", seguranca: "🔒 Alterou" };
  const auditEntityLabels = { presenca: "um registo de presença", falta: "um pedido de falta", conta: "a própria palavra-passe" };

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
        ? `
          <span style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; flex-shrink:0;">
            <span class="li-tag" data-role="edit" style="cursor:pointer;">✏️ Editar</span>
            <span class="li-tag" data-role="toggle" style="cursor:pointer;">${loc.active ? "Desativar" : "Ativar"}</span>
            <span class="li-tag" data-role="delete" style="cursor:pointer;">🗑️ Remover</span>
          </span>
        `
        : `<span class="li-tag">${locationLabel(loc.type)}</span>`;
      row.innerHTML = `
        <span class="li-main">
          <span class="avatar">${locationIcon(loc.type)}</span>
          <span class="li-name">${escapeHtml(loc.name)} ${loc.active ? "" : "(inativo)"}${loc.latitude != null ? " 📍" : ""}</span>
        </span>
        ${tag}
      `;
      const editEl = row.querySelector('[data-role="edit"]');
      if (editEl) {
        editEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openEditLocationModal(loc.id);
        });
      }
      const toggleEl = row.querySelector('[data-role="toggle"]');
      if (toggleEl) {
        toggleEl.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await supabase.from("locations").update({ active: !loc.active }).eq("id", loc.id);
          loadDashboard();
        });
      }
      const deleteEl = row.querySelector('[data-role="delete"]');
      if (deleteEl) {
        deleteEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          deleteLocation(loc.id);
        });
      }
      box.appendChild(row);
    });
  }

  // -----------------------------------------------------------
  // Gestão: editar / remover uma obra ou escritório (apenas admin)
  // -----------------------------------------------------------
  function openEditLocationModal(locationId) {
    const loc = state.dashboard.locations.find((l) => l.id === locationId);
    if (!loc) return;
    state.editingLocationId = locationId;

    document.getElementById("edit-location-name").value = loc.name || "";
    document.getElementById("edit-location-type").value = loc.type;
    document.getElementById("edit-location-lat").value = loc.latitude != null ? loc.latitude : "";
    document.getElementById("edit-location-lng").value = loc.longitude != null ? loc.longitude : "";
    document.getElementById("edit-location-radius").value = loc.radius_m != null ? loc.radius_m : "100";
    document.getElementById("edit-location-geo-status").textContent = "";

    document.getElementById("edit-location-modal").hidden = false;
  }

  document.getElementById("edit-location-geo-btn").addEventListener("click", () => {
    captureGeoInto("edit-location-geo-status", (lat, lng) => {
      document.getElementById("edit-location-lat").value = lat.toFixed(6);
      document.getElementById("edit-location-lng").value = lng.toFixed(6);
    });
  });

  document.getElementById("edit-location-cancel").addEventListener("click", () => {
    document.getElementById("edit-location-modal").hidden = true;
    state.editingLocationId = null;
  });

  document.getElementById("edit-location-save").addEventListener("click", async () => {
    if (!state.editingLocationId) return;
    const nameInput = document.getElementById("edit-location-name");
    const typeInput = document.getElementById("edit-location-type");
    const latInput = document.getElementById("edit-location-lat");
    const lngInput = document.getElementById("edit-location-lng");
    const radiusInput = document.getElementById("edit-location-radius");

    const name = nameInput.value.trim();
    if (!name) { toast("Indica o nome da obra/escritório", true); return; }

    const payload = { name, type: typeInput.value };
    const lat = parseFloat(String(latInput.value).replace(",", "."));
    const lng = parseFloat(String(lngInput.value).replace(",", "."));
    if (!isNaN(lat) && !isNaN(lng)) {
      payload.latitude = lat;
      payload.longitude = lng;
      const radius = parseInt(radiusInput.value, 10);
      payload.radius_m = !isNaN(radius) && radius > 0 ? radius : 100;
    } else if (latInput.value.toString().trim() || lngInput.value.toString().trim()) {
      toast("Latitude/Longitude inválidas — deixa ambas em branco ou preenche as duas", true);
      return;
    } else {
      payload.latitude = null;
      payload.longitude = null;
      payload.radius_m = 100;
    }

    const { error } = await supabase.from("locations").update(payload).eq("id", state.editingLocationId);
    if (error) { console.error(error); toast("Não foi possível guardar a alteração", true); return; }

    document.getElementById("edit-location-modal").hidden = true;
    state.editingLocationId = null;
    toast("Obra/escritório atualizado");
    loadDashboard();
  });

  async function deleteLocation(locationId) {
    const loc = state.dashboard.locations.find((l) => l.id === locationId);
    if (!loc) return;
    if (!window.confirm(`Remover "${loc.name}"? Só é possível remover locais que nunca tiveram nenhuma marcação de presença associada.`)) return;

    const { error } = await supabase.from("locations").delete().eq("id", locationId);
    if (error) {
      console.error(error);
      // Restrição da base de dados: não deixa apagar um local que já tem
      // registos de presença associados (para nunca perder histórico).
      if (error.code === "23503") {
        toast('Este local já tem marcações de presença associadas — não pode ser removido. Usa "Desativar" para o deixar de mostrar como opção, sem perder o histórico.', true);
      } else {
        toast("Não foi possível remover o local", true);
      }
      return;
    }
    toast("Local removido");
    loadDashboard();
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
      Tarefas: formatTasksSummary(rec.tasks),
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
  // Gestão: cópia de segurança completa (todos os dados, todas as
  // tabelas) — um ficheiro Excel de várias folhas para guardares fora
  // do Supabase de vez em quando. Só para administradores.
  // -----------------------------------------------------------
  function sheetOrPlaceholder(rows, placeholderMsg) {
    return rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.json_to_sheet([{ Aviso: placeholderMsg }]);
  }

  document.getElementById("export-backup-btn").addEventListener("click", async () => {
    const btn = document.getElementById("export-backup-btn");
    btn.disabled = true;
    btn.textContent = "A preparar cópia de segurança…";
    try {
      const [
        { data: employees, error: e1 },
        { data: locations, error: e2 },
        { data: attendance, error: e3 },
        { data: absences, error: e4 },
        { data: audit, error: e5 },
      ] = await Promise.all([
        supabase.from("employees").select("*").order("name"),
        supabase.from("locations").select("*").order("name"),
        supabase.from("attendance_records").select("*, employees(name), locations(name, type)").order("created_at", { ascending: false }),
        supabase.from("absence_requests").select("*, employees(name)").order("created_at", { ascending: false }),
        supabase.from("audit_log").select("*").order("created_at", { ascending: false }),
      ]);
      const firstError = e1 || e2 || e3 || e4 || e5;
      if (firstError) throw firstError;

      const empRows = (employees || []).map((e) => ({
        ID: e.id, Nome: e.name, Departamento: e.department || "", Ativo: e.active ? "Sim" : "Não",
        "Criado em": new Date(e.created_at).toLocaleString("pt-PT"),
      }));
      const locRows = (locations || []).map((l) => ({
        ID: l.id, Nome: l.name, Tipo: locationLabel(l.type),
        Latitude: l.latitude ?? "", Longitude: l.longitude ?? "", "Raio (m)": l.radius_m ?? "",
        Ativo: l.active ? "Sim" : "Não",
      }));
      const attRows = (attendance || []).map((r) => ({
        ID: r.id, Funcionário: r.employees?.name || "", Local: r.locations?.name || "", Tipo: locationLabel(r.locations?.type),
        Direção: r.direction === "entrada" ? "Entrada" : "Saída", "Data/Hora": new Date(r.created_at).toLocaleString("pt-PT"),
        Latitude: r.latitude ?? "", Longitude: r.longitude ?? "", Nota: r.note || "",
        Tarefas: formatTasksSummary(r.tasks),
        Estado: r.review_status || "", "Aprovado/Rejeitado por": r.reviewed_by || "", "Editado por": r.updated_by || "",
      }));
      const absRows = (absences || []).map((a) => ({
        ID: a.id, Funcionário: a.employees?.name || "", Data: a.absence_date, Motivo: absenceReasonLabel(a.reason),
        Nota: a.note || "", "Tem foto": a.photo_path ? "Sim" : "Não", Estado: a.status,
        "Aprovado/Rejeitado por": a.reviewed_by || "", "Pedido em": new Date(a.created_at).toLocaleString("pt-PT"),
      }));
      const auditRows = (audit || []).map((h) => ({
        Quando: new Date(h.created_at).toLocaleString("pt-PT"), Quem: h.actor_name || h.actor_email || "",
        Ação: auditActionLabels[h.action] || h.action, Sobre: auditEntityLabels[h.entity_type] || h.entity_type,
        Descrição: h.entity_label || "",
      }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(empRows, "Sem funcionários"), "Funcionários");
      XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(locRows, "Sem locais"), "Locais");
      XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(attRows, "Sem registos de presença"), "Registos");
      XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(absRows, "Sem pedidos de falta"), "Faltas");
      XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(auditRows, "Sem histórico"), "Histórico");

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `proqual-backup-completo-${stamp}.xlsx`);
      toast("Cópia de segurança gerada");
    } catch (err) {
      console.error(err);
      toast("Não foi possível gerar a cópia de segurança", true);
    } finally {
      btn.disabled = false;
      btn.textContent = "💾 Cópia de segurança completa (todos os dados)";
    }
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
    const pad = (n) => String(n).padStart(2, "0");
    const startDateStr = `${year}-${pad(month)}-01`;
    const endDateStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;

    const [{ data, error }, { data: absenceData, error: absError }] = await Promise.all([
      supabase
        .from("attendance_records")
        .select("employee_id, direction, created_at, review_status, employees(name, department)")
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .order("created_at", { ascending: true }),
      supabase
        .from("absence_requests")
        .select("employee_id, absence_date, status, employees(name, department)")
        .gte("absence_date", startDateStr)
        .lt("absence_date", endDateStr),
    ]);

    if (error) { console.error(error); box.innerHTML = '<p class="list-empty">Erro ao carregar o resumo.</p>'; return; }
    if (absError) console.error(absError); // não bloqueia o resumo de horas por causa das faltas

    // Registos de "Serviço Externo" rejeitados pela Gestão não contam
    // para as horas trabalhadas (a presença não foi confirmada).
    const validData = (data || []).filter((rec) => rec.review_status !== "rejeitado");
    // Só faltas já aprovadas pela Gestão contam como "falta justificada" confirmada.
    const approvedAbsences = (absenceData || []).filter((req) => req.status === "aprovado");

    if (!validData.length && !approvedAbsences.length) {
      box.innerHTML = '<p class="list-empty">Sem registos neste mês.</p>';
      return;
    }

    // Agrupa por funcionário — junta registos de presença e faltas
    // aprovadas, para dar o panorama completo do mês.
    const byEmployee = new Map();
    function ensureEmployee(id, name, department) {
      if (!byEmployee.has(id)) {
        byEmployee.set(id, { name: name || "—", department: department || "—", records: [], absenceDays: new Set() });
      }
      return byEmployee.get(id);
    }
    validData.forEach((rec) => {
      ensureEmployee(rec.employee_id, rec.employees?.name, rec.employees?.department).records.push(rec);
    });
    approvedAbsences.forEach((req) => {
      ensureEmployee(req.employee_id, req.employees?.name, req.employees?.department).absenceDays.add(req.absence_date);
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
        absenceDays: emp.absenceDays.size,
      });
    });

    summaries.sort((a, b) => a.name.localeCompare(b.name, "pt"));

    box.innerHTML = "";
    summaries.forEach((s) => {
      const absenceTag = s.absenceDays ? ` · 🗓️ ${s.absenceDays} falta(s) justificada(s)` : "";
      const div = document.createElement("div");
      div.className = "summary-card";
      div.innerHTML = `
        <div>
          <div class="s-name">${escapeHtml(s.name)}</div>
          <div class="s-sub">${escapeHtml(s.department)} · ${s.days} dia(s) com registo${s.incomplete ? " · ⚠️ tem uma entrada sem saída" : ""}${absenceTag}</div>
        </div>
        <div class="s-hours">${s.hours.toFixed(1)}h<small>total no mês</small></div>
      `;
      box.appendChild(div);
    });
  }

  document.querySelector('[data-tab="resumo"]').addEventListener("click", loadMonthlySummary);

  // -----------------------------------------------------------
  // Gestão: Ponto Individual — folha de ponto dia a dia por
  // funcionário, com exportação em Excel e PDF.
  // -----------------------------------------------------------
  const individualEmployeeSelect = document.getElementById("individual-employee-select");
  const individualMonthInput = document.getElementById("individual-month");
  if (!individualMonthInput.value) individualMonthInput.value = defaultMonthValue();
  individualEmployeeSelect.addEventListener("change", loadIndividualTimesheet);
  individualMonthInput.addEventListener("change", loadIndividualTimesheet);
  document.querySelector('[data-tab="individual"]').addEventListener("click", () => {
    if (individualEmployeeSelect.value) loadIndividualTimesheet();
  });

  async function loadIndividualTimesheet() {
    const box = document.getElementById("individual-timesheet-list");
    const exportXlsxBtn = document.getElementById("individual-export-xlsx-btn");
    const exportPdfBtn = document.getElementById("individual-export-pdf-btn");
    const empId = individualEmployeeSelect.value;

    if (!empId) {
      box.innerHTML = '<p class="list-empty">Escolhe um funcionário para ver a folha de ponto do mês.</p>';
      exportXlsxBtn.hidden = true;
      exportPdfBtn.hidden = true;
      state.individualTimesheet = null;
      return;
    }

    box.innerHTML = '<p class="list-empty">A carregar…</p>';
    const monthVal = individualMonthInput.value || defaultMonthValue();
    const [year, month] = monthVal.split("-").map(Number);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);
    const pad = (n) => String(n).padStart(2, "0");
    const startDateStr = `${year}-${pad(month)}-01`;
    const endDateStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;

    const [{ data, error }, { data: absenceData, error: absError }] = await Promise.all([
      supabase
        .from("attendance_records")
        .select("direction, created_at, review_status, employee_id, tasks")
        .eq("employee_id", empId)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
        .order("created_at", { ascending: true }),
      supabase
        .from("absence_requests")
        .select("absence_date, status, reason, employee_id")
        .eq("employee_id", empId)
        .gte("absence_date", startDateStr)
        .lt("absence_date", endDateStr),
    ]);

    if (error) { console.error(error); box.innerHTML = '<p class="list-empty">Erro ao carregar a folha de ponto.</p>'; return; }
    if (absError) console.error(absError); // não bloqueia a folha de ponto por causa das faltas

    const validData = (data || []).filter((rec) => rec.review_status !== "rejeitado");
    const approvedAbsences = (absenceData || []).filter((req) => req.status === "aprovado");
    const employee = state.dashboard.employees.find((e) => e.id === empId);

    // Agrupa os registos de presença por dia (o dia do próprio registo,
    // não o dia da entrada — evita perder registos quando há mais do que
    // um par entrada/saída no mesmo dia, ou uma Saída "órfã" sem entrada
    // correspondente nesse dia, que continua a app a permitir com apenas
    // um aviso). Dentro de cada dia, empareha sequencialmente para somar
    // as horas, mas recolhe SEMPRE as tarefas de todas as saídas desse
    // dia, independentemente de terem encontrado uma entrada aberta.
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const byDay = new Map();
    validData.forEach((rec) => {
      const t = new Date(rec.created_at);
      const key = ymd(t);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ direction: rec.direction, time: t, tasks: rec.tasks });
    });

    const dayMap = new Map();
    byDay.forEach((recs, key) => {
      recs.sort((a, b) => a.time - b.time);
      let openEntrada = null;
      let firstEntrada = null;
      let lastSaida = null;
      let hours = 0;
      const tasksAll = [];
      recs.forEach((r) => {
        if (r.direction === "entrada") {
          if (!firstEntrada) firstEntrada = r.time;
          openEntrada = r.time;
        } else if (r.direction === "saida") {
          if (!lastSaida || r.time > lastSaida) lastSaida = r.time;
          if (openEntrada) {
            hours += (r.time - openEntrada) / 3600000;
            openEntrada = null;
          }
          if (Array.isArray(r.tasks) && r.tasks.length) tasksAll.push(...r.tasks);
        }
      });
      dayMap.set(key, {
        entrada: firstEntrada,
        saida: lastSaida,
        hours,
        incomplete: !!openEntrada,
        tasks: tasksAll.length ? tasksAll : null,
      });
    });

    const absenceMap = new Map();
    approvedAbsences.forEach((req) => absenceMap.set(req.absence_date, req.reason));

    const allDates = new Set([...dayMap.keys(), ...absenceMap.keys()]);
    const timeFmt = (d) => d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
    const rows = [...allDates].sort().map((date) => {
      const att = dayMap.get(date);
      const absenceReason = absenceMap.get(date);
      const situacaoParts = [];
      if (absenceReason) situacaoParts.push(`Falta justificada — ${absenceReasonLabel(absenceReason)}`);
      if (att?.incomplete) situacaoParts.push("⚠️ Sem saída registada");
      return {
        date,
        dateLabel: new Date(date + "T00:00:00").toLocaleDateString("pt-PT"),
        entrada: att?.entrada ? timeFmt(att.entrada) : "",
        saida: att?.saida ? timeFmt(att.saida) : "",
        hours: att?.hours || 0,
        incomplete: !!att?.incomplete,
        isAbsence: !att && !!absenceReason,
        tarefas: formatTasksSummary(att?.tasks),
        situacao: situacaoParts.join(" · "),
      };
    });

    const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
    const totalDays = rows.filter((r) => !r.isAbsence).length;
    const totalAbsences = rows.filter((r) => r.isAbsence || (r.situacao && r.situacao.startsWith("Falta"))).length;

    state.individualTimesheet = {
      employeeId: empId,
      employeeName: employee?.name || "—",
      employeeDept: employee?.department || "—",
      monthVal,
      rows,
      totalHours,
      totalDays,
      totalAbsences,
    };

    renderIndividualTimesheet();
    exportXlsxBtn.hidden = rows.length === 0;
    exportPdfBtn.hidden = rows.length === 0;
  }

  function renderIndividualTimesheet() {
    const box = document.getElementById("individual-timesheet-list");
    const ts = state.individualTimesheet;
    if (!ts || !ts.rows.length) {
      box.innerHTML = '<p class="list-empty">Sem registos nem faltas aprovadas neste mês.</p>';
      return;
    }
    const rowsHtml = ts.rows.map((r) => {
      const cls = [r.isAbsence ? "ts-absence" : "", r.incomplete ? "ts-incomplete" : ""].filter(Boolean).join(" ");
      return `
        <tr class="${cls}">
          <td>${r.dateLabel}</td>
          <td>${r.entrada || "—"}</td>
          <td>${r.saida || "—"}</td>
          <td>${r.hours ? r.hours.toFixed(1) + "h" : "—"}</td>
          <td class="ts-note">${escapeHtml(r.tarefas || "")}</td>
          <td class="ts-note">${escapeHtml(r.situacao || "")}</td>
        </tr>
      `;
    }).join("");
    box.innerHTML = `
      <div class="timesheet-summary">
        <div><strong>${ts.totalHours.toFixed(1)}h</strong>total no mês</div>
        <div><strong>${ts.totalDays}</strong>dia(s) com registo</div>
        <div><strong>${ts.totalAbsences}</strong>falta(s) justificada(s)</div>
      </div>
      <div class="timesheet-table-wrap">
        <table class="timesheet-table">
          <thead><tr><th>Data</th><th>Entrada</th><th>Saída</th><th>Horas</th><th>Tarefas</th><th>Situação</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function individualMonthLabel(monthVal) {
    const [y, m] = monthVal.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
  }

  document.getElementById("individual-export-xlsx-btn").addEventListener("click", () => {
    const ts = state.individualTimesheet;
    if (!ts) return;
    const monthLabel = individualMonthLabel(ts.monthVal);
    const now = new Date();
    const headerLines = [[cfg.COMPANY_NAME || "PROQUAL Engenheiros e Associados, Lda"]];
    if (cfg.COMPANY_TAGLINE) headerLines.push([cfg.COMPANY_TAGLINE]);
    if (cfg.COMPANY_NUIT) headerLines.push([`NUIT: ${cfg.COMPANY_NUIT}`]);
    if (cfg.COMPANY_ADDRESS) headerLines.push([cfg.COMPANY_ADDRESS]);
    headerLines.push([`Folha de Ponto Individual — ${ts.employeeName} (${ts.employeeDept})`]);
    headerLines.push([`Mês: ${monthLabel}`]);
    headerLines.push([`Documento gerado automaticamente pelo sistema ${cfg.APP_TITLE} em ${now.toLocaleString("pt-PT")}`]);
    headerLines.push([]);

    const columns = ["Data", "Entrada", "Saída", "Horas", "Tarefas", "Situação"];
    const dataRows = ts.rows.map((r) => [r.dateLabel, r.entrada || "", r.saida || "", r.hours ? Number(r.hours.toFixed(2)) : "", r.tarefas || "", r.situacao || ""]);
    const totalsRow = ["", "", "Total", Number(ts.totalHours.toFixed(2)), "", `${ts.totalAbsences} falta(s) justificada(s)`];
    const aoa = [...headerLines, columns, ...dataRows, [], totalsRow];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Folha de Ponto");
    const safeName = ts.employeeName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
    XLSX.writeFile(wb, `folha-ponto-${safeName}-${ts.monthVal}.xlsx`);
  });

  document.getElementById("individual-export-pdf-btn").addEventListener("click", () => {
    const ts = state.individualTimesheet;
    if (!ts) return;
    try {
      const monthLabel = individualMonthLabel(ts.monthVal);
      const now = new Date();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "pt" });

      let y = 40;
      doc.setFontSize(14);
      doc.text(cfg.COMPANY_NAME || "PROQUAL Engenheiros e Associados, Lda", 40, y);
      y += 18;
      doc.setFontSize(9);
      if (cfg.COMPANY_TAGLINE) { doc.text(cfg.COMPANY_TAGLINE, 40, y); y += 14; }
      if (cfg.COMPANY_NUIT) { doc.text(`NUIT: ${cfg.COMPANY_NUIT}`, 40, y); y += 14; }
      if (cfg.COMPANY_ADDRESS) { doc.text(cfg.COMPANY_ADDRESS, 40, y); y += 14; }
      y += 10;
      doc.setFontSize(12);
      doc.text(`Folha de Ponto Individual — ${ts.employeeName} (${ts.employeeDept})`, 40, y);
      y += 16;
      doc.setFontSize(10);
      doc.text(`Mês: ${monthLabel}`, 40, y);
      y += 14;
      doc.setFontSize(8);
      doc.text(`Documento gerado automaticamente pelo sistema ${cfg.APP_TITLE} em ${now.toLocaleString("pt-PT")}`, 40, y);
      y += 16;

      doc.autoTable({
        startY: y,
        head: [["Data", "Entrada", "Saída", "Horas", "Tarefas", "Situação"]],
        body: ts.rows.map((r) => [r.dateLabel, r.entrada || "—", r.saida || "—", r.hours ? r.hours.toFixed(1) + "h" : "—", r.tarefas || "", r.situacao || ""]),
        foot: [["", "", "Total", `${ts.totalHours.toFixed(1)}h`, "", `${ts.totalAbsences} falta(s) justificada(s)`]],
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [30, 41, 59] },
        footStyles: { fillColor: [240, 240, 240], textColor: [20, 20, 20] },
        margin: { left: 40, right: 40 },
      });

      const finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || y + 40;
      const sigY = finalY + 50;
      doc.setFontSize(9);
      doc.text("_______________________________", 40, sigY);
      doc.text("Assinatura do Funcionário", 40, sigY + 14);
      doc.text("_______________________________", 320, sigY);
      doc.text("Assinatura da Gestão", 320, sigY + 14);

      const safeName = ts.employeeName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
      doc.save(`folha-ponto-${safeName}-${ts.monthVal}.pdf`);
    } catch (err) {
      console.error(err);
      toast("Não foi possível gerar o PDF", true);
    }
  });

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
