// limina hub — the management surface front-end. Lists projects from the hub's
// API, creates new ones (validated), opens/resumes stacks, and navigates into
// the studio when the stack's URL arrives. All state lives server-side; this
// file is presentation + fetch.

const $ = (id) => document.getElementById(id);

function toast(message, isError = false, ms = 3200) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, ms);
}

async function api(path, body) {
  const init = body === undefined
    ? { method: "GET", cache: "no-store" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok || parsed.ok === false) throw new Error(parsed.error ?? `hub request failed (HTTP ${res.status})`);
  return parsed;
}

function relTime(ms) {
  if (ms === null || ms === undefined) return "never opened";
  const delta = Date.now() - ms;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function busyOn(card, label) {
  const busy = document.createElement("div");
  busy.className = "busy";
  busy.innerHTML = `<span class="spin"></span><span>${label}</span>`;
  card.appendChild(busy);
  return () => busy.remove();
}

async function openProject(card, root) {
  if (card.dataset.busy === "1") return;
  card.dataset.busy = "1";
  const unbusy = busyOn(card, "booting the world…");
  try {
    const { url } = await api("/api/projects/open", { root });
    window.location.href = url;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true, 5000);
    card.dataset.busy = "0";
    unbusy();
  }
}

function projectCard(project) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const badge = project.running ? '<span class="badge">running</span>' : "";
  const action = project.running ? "Resume →" : "Open →";
  card.innerHTML = `
    <div class="name"></div>
    <div class="path"></div>
    <div class="meta">${badge}<span class="touched"></span><span class="action">${action}</span></div>`;
  card.querySelector(".name").textContent = project.projectId;
  card.querySelector(".path").textContent = project.root;
  card.querySelector(".touched").textContent = relTime(project.lastTouched);
  card.addEventListener("click", () => openProject(card, project.root));
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") openProject(card, project.root); });
  return card;
}

function renderProjects(payload) {
  const grid = $("projects-grid");
  grid.replaceChildren();
  const projects = payload.projects ?? [];
  $("projects-label").hidden = projects.length === 0;
  $("empty").hidden = projects.length !== 0;
  for (const project of projects) grid.appendChild(projectCard(project));
  $("root-line").textContent = `projects: ${payload.projectsRoot}`;
}

async function refresh() {
  try {
    renderProjects(await api("/api/projects"));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true, 5000);
  }
}

// ── create dialog ────────────────────────────────────────────────────────────
function openCreateDialog() {
  $("create-error").textContent = "";
  $("create-name").value = "";
  $("create-dialog").hidden = false;
  $("create-name").focus();
}
function closeCreateDialog() { $("create-dialog").hidden = true; }

async function submitCreate() {
  const name = $("create-name").value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    $("create-error").textContent = "lowercase letters, digits, '-', '_' or '.', starting with a letter or digit";
    $("create-name").focus();
    return;
  }
  const submit = $("create-submit");
  submit.disabled = true;
  submit.textContent = "Creating…";
  try {
    await api("/api/projects/create", { name });
    closeCreateDialog();
    toast(`created ${name} — booting it now`);
    await openProject($("start-grid"), `${await rootOf()}${name}`);
  } catch (error) {
    $("create-error").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    submit.disabled = false;
    submit.textContent = "Create & open";
  }
}
let cachedRoot = "";
async function rootOf() {
  if (cachedRoot === "") {
    const payload = await api("/api/projects");
    cachedRoot = payload.projectsRoot.endsWith("/") ? payload.projectsRoot : payload.projectsRoot + "/";
  }
  return cachedRoot;
}

$("new-project").addEventListener("click", openCreateDialog);
$("new-project").addEventListener("keydown", (e) => { if (e.key === "Enter") openCreateDialog(); });
$("create-cancel").addEventListener("click", closeCreateDialog);
$("create-submit").addEventListener("click", submitCreate);
$("create-name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitCreate(); });
$("create-dialog").addEventListener("click", (e) => { if (e.target === $("create-dialog")) closeCreateDialog(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCreateDialog(); });

refresh();
