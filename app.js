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
    session: null, // sessão de auth da Gestão
    dashboard: { records: [], employees: [], locations: [] },
  };

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
    if (dirBtn) { state.direction = dirBtn.dataset.direction; showScreen("confirm-presence"); return; }
  });

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

  document.getElementById("new-location-continue").addEventListener("click", async () => {
    const nameInput = document.getElementById("new-location-name");
    const typeInput = document.getElementById("new-location-type");
    const name = nameInput.value.trim();
    if (!name) { toast("Escreve o nome do local", true); return; }
    const { data, error } = await supabase
      .from("locations")
      .insert({ name, type: typeInput.value })
      .select()
      .single();
    if (error) { console.error(error); toast("Não foi possível criar o local", true); return; }
    nameInput.value = "";
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

    startCamera();
    startClock();
    requestGps();
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
    showScreen("admin-dashboard");
  });

  document.getElementById("admin-logout-btn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    state.session = null;
    showScreen("home");
  });

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
    const [{ data: employees }, { data: locations }] = await Promise.all([
      supabase.from("employees").select("*").order("name"),
      supabase.from("locations").select("*").order("name"),
    ]);
    state.dashboard.employees = employees || [];
    state.dashboard.locations = locations || [];

    fillSelect("filter-employee", state.dashboard.employees, "Todos os funcionários");
    fillSelect("filter-location", state.dashboard.locations, "Todos os locais");
    renderAdminEmployeeList();
    renderAdminLocationList();
    await loadRecords();
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
      .limit(200);

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

    if (!data.length) { box.innerHTML = '<p class="list-empty">Sem registos para este filtro.</p>'; return; }

    box.innerHTML = "";
    data.forEach((rec) => {
      const when = new Date(rec.created_at).toLocaleString("pt-PT");
      const mapLink = (rec.latitude && rec.longitude)
        ? `<a href="https://maps.google.com/?q=${rec.latitude},${rec.longitude}" target="_blank" rel="noopener">Ver no mapa</a>`
        : "Sem localização";
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
        </div>
        <span class="record-badge ${rec.direction === "entrada" ? "record-badge--in" : "record-badge--out"}">
          ${rec.direction === "entrada" ? "Entrada" : "Saída"}
        </span>
      `;
      box.appendChild(div);
    });
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
      row.innerHTML = `
        <span class="li-main">
          <span class="avatar">${initials(emp.name)}</span>
          <span class="li-name">${escapeHtml(emp.name)} ${emp.active ? "" : "(inativo)"}</span>
        </span>
        <span class="li-tag" data-role="toggle" style="cursor:pointer;">${emp.department || "—"} · ${emp.active ? "Desativar" : "Ativar"}</span>
      `;
      row.querySelector('[data-role="toggle"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await supabase.from("employees").update({ active: !emp.active }).eq("id", emp.id);
        loadDashboard();
      });
      box.appendChild(row);
    });
  }

  function renderAdminLocationList() {
    const box = document.getElementById("admin-location-list");
    box.innerHTML = "";
    state.dashboard.locations.forEach((loc) => {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <span class="li-main">
          <span class="avatar">${locationIcon(loc.type)}</span>
          <span class="li-name">${escapeHtml(loc.name)} ${loc.active ? "" : "(inativo)"}</span>
        </span>
        <span class="li-tag" data-role="toggle" style="cursor:pointer;">${locationLabel(loc.type)} · ${loc.active ? "Desativar" : "Ativar"}</span>
      `;
      row.querySelector('[data-role="toggle"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await supabase.from("locations").update({ active: !loc.active }).eq("id", loc.id);
        loadDashboard();
      });
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

  document.getElementById("admin-add-location-btn").addEventListener("click", async () => {
    const nameInput = document.getElementById("admin-new-location-name");
    const typeInput = document.getElementById("admin-new-location-type");
    const name = nameInput.value.trim();
    if (!name) return;
    const { error } = await supabase.from("locations").insert({ name, type: typeInput.value });
    if (error) { console.error(error); toast("Erro ao adicionar local", true); return; }
    nameInput.value = "";
    loadDashboard();
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
  });

  showScreen("home");
})();
