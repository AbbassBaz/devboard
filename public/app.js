const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const home = (p) => (p ? p.replace(/^\/Users\/[^/]+/, "~") : "");
let latest = [];
let projects = [];
let presets = [];
let alerts = [];
let worktrees = [];
let wtStale = [];
let tab = "board";
const busy = new Map();
const setBusy = (id, state) => busy.set(id, { state, at: Date.now() });
let openLog = null;
let editingId = null;
let editingProjectId = null;

function lastWtDir() {
  try { return localStorage.getItem("devboard.worktreesDir") || ""; } catch { return ""; }
}
function saveWtDir(dir) {
  try { localStorage.setItem("devboard.worktreesDir", dir); } catch {}
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = "none"), 4500);
}
function envBlock(env) {
  const keys = Object.keys(env || {}).sort();
  if (!keys.length) return "none";
  return keys.map((k) => `${k}=${env[k]}`).join("\n");
}
function closeEnv() {
  $("#envPane").classList.remove("open");
  $("#envPane").setAttribute("aria-hidden", "true");
}
async function openEnv(s) {
  $("#envTitle").textContent = s.name;
  $("#envSaved").textContent = formatEnv(s.env) || "none";
  $("#envLive").textContent = s.rootPid ? "reading…" : "not running";
  $("#envPane").classList.add("open");
  $("#envPane").setAttribute("aria-hidden", "false");
  if (!s.rootPid) return;
  try {
    const { env } = await api("GET", `/api/env?pid=${s.rootPid}`);
    $("#envLive").textContent = envBlock(env);
  } catch (e) {
    $("#envLive").textContent = e.message;
  }
}

function showTab(name) {
  tab = name;
  ["board", "worktrees", "attention"].forEach((id) => {
    $(`#view-${id}`).hidden = id !== name;
    const btn = document.querySelector(`nav.pills [data-tab="${id}"]`);
    btn.classList.toggle("on", id === name);
  });
  if (name === "worktrees") {
    if (!$("#wt-dir").value) $("#wt-dir").value = lastWtDir() || "~/Documents/Personal/Projects";
    if (!worktrees.length && !wtStale.length) scanWt();
  }
  if (name === "attention") loadAttention();
}
$$("nav.pills [data-tab]").forEach((btn) => btn.onclick = () => showTab(btn.dataset.tab));

function closeForms() {
  $("#addForm").hidden = true; editingId = null; $("#formError").textContent = "";
  $("#projectForm").hidden = true; editingProjectId = null; $("#projectError").textContent = "";
  $("#presetForm").hidden = true; $("#presetError").textContent = "";
}
function formatEnv(env) {
  if (!env || !Object.keys(env).length) return "";
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
}
async function loadSuggest(dir) {
  const box = $("#f-suggest");
  if (!dir?.trim()) { box.hidden = true; box.innerHTML = ""; return; }
  try {
    const { suggestions } = await api("GET", `/api/suggest?dir=${encodeURIComponent(dir.trim())}`);
    if (!suggestions?.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = suggestions.map((s) =>
      `<button type="button" class="suggest" data-cmd="${esc(s.command)}" data-port="${s.port ?? ""}">${esc(s.label)} <span class="mono">${esc(s.command)}${s.port ? " · :" + s.port : ""}</span></button>`
    ).join("");
  } catch {
    box.hidden = true;
    box.innerHTML = "";
  }
}
function openForm(s) {
  closeForms();
  const f = $("#addForm");
  editingId = s ? s.id : null;
  f.reset();
  $("#f-suggest").hidden = true;
  $("#f-suggest").innerHTML = "";
  if (s) {
    f.elements.name.value = s.name;
    f.elements.cwd.value = s.cwd ?? "";
    f.elements.command.value = s.command ?? "";
    f.elements.port.value = s.ports[0];
    f.elements.healthUrl.value = s.healthUrl ?? "";
    f.elements.envText.value = formatEnv(s.env);
    f.elements.restartOnCrash.checked = !!s.restartOnCrash;
    loadSuggest(s.cwd);
  }
  $("#formTitle").textContent = s ? `Edit ${s.name}` : "Add a server";
  $("#formSubmit").textContent = s ? "Save changes" : "Add server";
  f.hidden = false;
  f.scrollIntoView({ block: "nearest" });
  $("#f-name").focus();
}
function openProjectForm(p) {
  closeForms();
  editingProjectId = p ? p.id : null;
  const f = $("#projectForm");
  f.reset();
  if (p) {
    f.elements.name.value = p.name;
    f.elements.folder.value = p.folder ?? "";
    f.elements.links.value = (p.links || []).map((l) => (l.label === l.url ? l.url : `${l.label} ${l.url}`)).join("\n");
    f.elements.addFromFolder.checked = false;
  }
  $("#projectTitle").textContent = p ? `Edit ${p.name}` : "New project";
  $("#projectSubmit").textContent = p ? "Save project" : "Create project";
  f.hidden = false;
  $("#p-name").focus();
}
function openPresetForm() {
  closeForms();
  const f = $("#presetForm");
  f.reset();
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden && s.id);
  $("#pr-services").innerHTML = dev.length
    ? dev.map((s) => `<label class="check"><input type="checkbox" name="serviceId" value="${esc(s.id)}" ${s.status === "running" ? "checked" : ""}> ${esc(s.name)} <span class="mono">:${s.ports[0] ?? "—"}</span></label>`).join("")
    : `<p class="empty" style="padding:0">Pin a server first, then save it here.</p>`;
  f.elements.urls.value = dev.filter((s) => s.status === "running" && s.ports[0]).map((s) => `http://127.0.0.1:${s.ports[0]}`).join("\n");
  f.hidden = false;
  $("#pr-name").focus();
}

function readinessOf(s) {
  const b = busy.get(s.id)?.state;
  if (b === "starting") return "starting";
  if (b === "stopping") return "stopped";
  return s.readiness || (s.status === "running" ? "ready" : "stopped");
}
function cheapAlerts(list) {
  const byPort = new Map();
  let unhealthy = 0;
  for (const s of list) {
    if (s.kind !== "dev" || s.hidden) continue;
    if (s.readiness === "unhealthy") unhealthy++;
    for (const port of s.ports) {
      const rows = byPort.get(port) ?? [];
      rows.push(s);
      byPort.set(port, rows);
    }
  }
  let conflicts = 0;
  for (const rows of byPort.values()) {
    if (new Set(rows.map((s) => s.cwd).filter(Boolean)).size > 1) conflicts++;
  }
  return { unhealthy, conflicts, total: unhealthy + conflicts + alerts.length };
}

function card(s) {
  const running = s.status === "running";
  const b = busy.get(s.id)?.state;
  const ready = readinessOf(s);
  const state = b ? "busy" : running ? "on" : "off";
  const ports = s.ports.map((p) => `<a class="port-link mono" href="http://127.0.0.1:${p}" target="_blank" rel="noopener" title="Open http://127.0.0.1:${p}">:${p}</a>`).join("");
  const health = s.health ? `   ${s.health.ok ? s.health.status : (s.health.error || s.health.status)} · ${s.health.ms}ms` : "";
  const facts = running
    ? `<span>pid ${s.rootPid}</span><span>up ${esc(s.uptime)}</span><span>${s.cpu != null ? s.cpu.toFixed(1) : "0.0"}% cpu</span><span>${s.memMb ?? 0} MB</span>`
    : `<span>off</span><span>${s.pinned ? "saved" : ""}</span>`;
  const actions = [
    `<button data-act="logs">Logs</button>`,
    `<button data-act="env">Env</button>`,
    running ? `<button data-act="restart" ${s.cwd ? "" : 'disabled title="working directory unknown"'}>Restart</button>` : "",
    running && !s.pinned ? `<button data-act="pin" ${s.cwd ? "" : 'disabled title="working directory unknown"'}>Pin</button>` : "",
    s.pinned ? `<button data-act="edit">Edit</button>` : "",
    s.pinned ? `<button data-act="remove" class="danger">Remove</button>` : "",
    s.projectId ? `<button data-act="ungroup">Ungroup</button>` : "",
    !s.projectId && projects.length === 1 ? `<button data-act="group" data-project="${esc(projects[0].id)}">Add to ${esc(projects[0].name)}</button>` : "",
    !s.projectId && projects.length > 1 ? `<select data-act="group-select" aria-label="Add to project"><option value="">Add to project…</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>` : "",
    `<button data-act="hide" title="Move this card to the hidden list">Hide</button>`,
  ].join("");
  const switchLabel = b === "starting" ? "Starting" : b === "stopping" ? "Stopping" : running ? `Turn ${s.name} off` : `Turn ${s.name} on`;
  return `<article class="card ${state} ${ready}" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
    <div class="rail"></div>
    <div class="head">
      <div>
        <div class="ready-tag">${esc(ready)}${s.pinned ? " · pinned" : ""}${s.restartOnCrash ? " · keep up" : ""}</div>
        <div class="name">${esc(s.name)}</div>
        <div class="ports">${ports}</div>
      </div>
      <button class="switch" role="switch" aria-checked="${running}" aria-label="${esc(switchLabel)}" title="${esc(switchLabel)}" data-act="toggle" ${b ? "disabled" : ""}><span class="knob"></span></button>
    </div>
    <div class="facts mono">${facts}${health}</div>
    <div class="path mono" title="${esc(s.cwd)}">${esc(home(s.cwd))}</div>
    <div class="cmd mono" title="${esc(s.command)}">${esc(s.command ?? "")}</div>
    <div class="actions">${actions}</div>
  </article>`;
}
function sysRow(s) {
  return `<div class="sysrow mono" data-id="${esc(s.id)}" data-name="${esc(s.name)}"><span class="n">${esc(s.name)}</span><span class="p">${s.ports.map((p) => ":" + p).join("  ")}</span><span>${s.rootPid}</span><span class="c" title="${esc(s.command)}">${esc(s.command)}</span><button data-act="kill-sys" data-root="${s.rootPid}">Kill</button></div>`;
}
function hiddenRow(s) {
  return `<div class="hiddenrow mono" data-id="${esc(s.id)}"><span class="n">${esc(s.name)}</span><span>${s.ports.map((p) => ":" + p).join("  ")}</span><span>${s.status}</span><button data-act="unhide">Show</button></div>`;
}
function projectBand(p) {
  const members = latest.filter((s) => p.memberIds.includes(s.id)).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "running" ? -1 : 1));
  const ports = p.ports.map((port) => `<a class="port-link mono" href="http://127.0.0.1:${port}" target="_blank" rel="noopener" title="Open http://127.0.0.1:${port}">:${port}</a>`).join("");
  const extra = (p.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("");
  const facts = `${p.on} on   ${p.off} off${p.on ? `   ${p.cpu.toFixed(1)}% cpu   ${p.memMb} MB` : ""}`;
  return `<section class="project" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-folder="${esc(p.folder ?? "")}">
    <header class="project-bar">
      <div>
        <p class="eyebrow">Project</p>
        <h3>${esc(p.name)}</h3>
        <div class="facts mono">${facts}${p.folder ? `   <span title="${esc(p.folder)}">${esc(home(p.folder))}</span>` : ""}</div>
        <div class="links">${ports}${extra}</div>
      </div>
      <div class="project-acts">
        <button class="ghost" data-act="project-start" ${p.off ? "" : "disabled"}>Start project</button>
        <button class="ghost danger" data-act="project-stop" ${p.on ? "" : "disabled"}>Stop project</button>
        ${p.folder ? `<button class="ghost" data-act="project-folder">Add from folder</button>` : ""}
        <button class="ghost" data-act="project-edit">Edit</button>
        <button class="ghost danger" data-act="project-delete">Remove</button>
      </div>
    </header>
    <div class="grid">${members.length ? members.map((s) => card({ ...s, projectId: p.id })).join("") : `<p class="empty">No servers in this project yet.</p>`}</div>
  </section>`;
}

function paintPresets() {
  const el = $("#presets");
  if (!presets.length) {
    el.innerHTML = `<p class="empty" style="padding:4px 0 8px">No resume presets yet. Save “Frontend only” or “Full stack” when the right servers are on.</p>`;
    return;
  }
  el.innerHTML = presets.map((p) => `<div class="preset" data-id="${esc(p.id)}">
    <strong>${esc(p.name)}</strong>
    <span class="mono" style="color:var(--dim)">${p.serviceIds.length} servers</span>
    <button data-act="preset-run">Resume</button>
    <button data-act="preset-del" class="danger">Remove</button>
  </div>`).join("");
}

function paintChips() {
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden);
  const on = dev.filter((s) => s.status === "running").length;
  const off = dev.filter((s) => s.status === "stopped").length;
  const sick = dev.filter((s) => s.readiness === "unhealthy").length;
  $("#chips").innerHTML = `
    <div class="chip on"><div class="k">Active</div><div class="v">${on}</div><div class="s">listening now</div></div>
    <div class="chip off"><div class="k">Idle</div><div class="v">${off}</div><div class="s">saved, waiting</div></div>
    <div class="chip proj"><div class="k">Projects</div><div class="v">${projects.length}</div><div class="s">${presets.length} resume preset${presets.length === 1 ? "" : "s"}</div></div>
    <div class="chip alert"><div class="k">Unhealthy</div><div class="v">${sick}</div><div class="s">${alerts.length ? alerts.length + " signals" : "health probes"}</div></div>`;
}

function paintStatus() {
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden);
  const on = dev.filter((s) => s.status === "running").length;
  const off = dev.filter((s) => s.status === "stopped").length;
  const cheap = cheapAlerts(latest);
  const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const label = cheap.unhealthy || cheap.conflicts || alerts.length
    ? `${cheap.unhealthy + cheap.conflicts + alerts.length} need attention · ${clock}`
    : `all systems operational · ${clock}`;
  $("#stamp").textContent = `${on} on   ${off} off   ${label}`;
  $("#status").className = "status" + (cheap.unhealthy || alerts.some((a) => a.kind === "exited") ? " bad" : cheap.conflicts || alerts.length ? " warn" : "");
  const n = Math.max(alerts.length, cheap.unhealthy + cheap.conflicts);
  $("#attnBadge").hidden = n === 0;
  $("#attnBadge").textContent = String(n);
}

function render() {
  const grouped = new Set(projects.flatMap((p) => p.memberIds));
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden);
  const hidden = latest.filter((s) => s.kind === "dev" && s.hidden);
  const sys = latest.filter((s) => s.kind === "system");
  const ungrouped = dev.filter((s) => !grouped.has(s.id));
  $("#hiddenSec").hidden = hidden.length === 0;
  $("#hiddenList").innerHTML = hidden.map(hiddenRow).join("");
  $("#hiddenCount").textContent = `(${hidden.length})`;
  $("#startAll").disabled = !dev.some((s) => s.status === "stopped");
  $("#stopAll").disabled = !dev.some((s) => s.status === "running");
  for (const [id, { state, at }] of busy) {
    const s = latest.find((x) => x.id === id);
    const settled = (state === "starting" && s?.status === "running") || (state === "stopping" && (!s || s.status === "stopped"));
    if (settled || Date.now() - at > 15000) busy.delete(id);
  }
  ungrouped.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "running" ? -1 : 1));
  $("#projects").innerHTML = projects.map(projectBand).join("");
  $("#otherLabel").hidden = !(projects.length && ungrouped.length);
  $("#dev").innerHTML = ungrouped.length ? ungrouped.map(card).join("") : (projects.length ? "" : `<p class="empty">Nothing running. Start a server from a terminal, or add one and switch it on.</p>`);
  $("#sysList").innerHTML = sys.map(sysRow).join("");
  $("#sysCount").textContent = `(${sys.length})`;
  paintChips();
  paintPresets();
  paintStatus();
  renderLog();
}

async function refresh() {
  try {
    const data = await api("GET", "/api/services");
    latest = data.services;
    projects = data.projects ?? [];
    presets = data.presets ?? [];
    render();
  } catch {
    $("#stamp").textContent = "devboard server unreachable";
    $("#status").className = "status bad";
  }
}
const refreshSoon = () => [700, 1600, 3000].forEach((ms) => setTimeout(refresh, ms));

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOG_TS = /^(\s*(?:\[[^\]]{6,32}\]|\d{4}-\d{2}-\d{2}[T ][\d:.Z+-]+|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*)/;
const LV_ERR = /\b(error|err!|fatal|panic|exception|uncaught|unhandled|econnrefused|enotfound|eaddrinuse|eacces|failed|failure|rejected|cannot |can't |exit(?:ed)? status|[✖×✗]|err_[a-z0-9_]+)\b|^\s*at\s+\S+/i;
const LV_WARN = /\b(warn(?:ing)?|deprecated|caution|slow|overrid)\b|[⚠]/i;
const LV_INFO = /\b(info|listening|ready|started|compiled|success|connected|http\/|GET |POST |PUT |PATCH |DELETE )\b/i;
const LV_DEBUG = /\b(debug|trace|verbose)\b/i;
function stripAnsi(s) { return s.replace(ANSI_RE, ""); }
function classifyLine(raw) {
  const text = stripAnsi(raw);
  const tagged = /^\s*(?:\[)?(error|err|fatal|warn(?:ing)?|info|debug|trace)(?:\])?\s*[:\-]/.exec(text.toLowerCase());
  if (tagged) {
    const t = tagged[1];
    if (t === "error" || t === "err" || t === "fatal") return "error";
    if (t.startsWith("warn")) return "warn";
    if (t === "info") return "info";
    return "debug";
  }
  if (LV_ERR.test(text)) return "error";
  if (LV_WARN.test(text)) return "warn";
  if (LV_INFO.test(text)) return "info";
  if (LV_DEBUG.test(text)) return "debug";
  return "other";
}
function splitLogLine(raw) {
  const text = stripAnsi(raw);
  const m = LOG_TS.exec(text);
  return m ? { time: m[1].trim(), body: text.slice(m[0].length) } : { time: "", body: text };
}
function wrapAnsi(text, cls) {
  if (!text) return "";
  if (!cls.length) return text;
  return `<span class="${cls.join(" ")}">${text}</span>`;
}
function colorizeText(raw) {
  if (!raw.includes("\x1b[")) return esc(raw);
  let html = "", cls = [], last = 0, m;
  const re = /\x1b\[([0-9;]*)m/g;
  while ((m = re.exec(raw))) {
    html += wrapAnsi(esc(raw.slice(last, m.index)), cls);
    last = re.lastIndex;
    const next = [];
    let bold = cls.includes("ansi-b"), dim = cls.includes("ansi-d"), color = cls.find((c) => c.startsWith("c"));
    for (const c of (m[1] ? m[1].split(";").map(Number) : [0])) {
      if (c === 0) { bold = false; dim = false; color = undefined; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) color = "c" + c;
    }
    if (bold) next.push("ansi-b");
    if (dim) next.push("ansi-d");
    if (color) next.push(color);
    cls = next;
  }
  return html + wrapAnsi(esc(raw.slice(last)), cls);
}
function markText(html, q) {
  if (!q) return html;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return html.replace(re, (m) => `<mark>${m}</mark>`);
}
function prettyJson(raw) {
  const t = stripAnsi(raw).trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return "";
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return ""; }
}
const LV_LABEL = { error: "ERR", warn: "WRN", info: "INF", debug: "DBG", other: "" };

let logLines = [];
let logShown = [];
let logMark = 0;
try { if (localStorage.getItem("devboard.logWrap") === "0") $("#logWrap").setAttribute("aria-pressed", "false"); } catch {}
function logWrapped() { return $("#logWrap").getAttribute("aria-pressed") !== "false"; }
function setWrap(on) {
  $("#logWrap").setAttribute("aria-pressed", on ? "true" : "false");
  $("#logWrap").textContent = on ? "Wrap" : "Unwrap";
  $("#logWrap").classList.toggle("on", on);
  $("#logBody").classList.toggle("wrap", on);
  $("#logBody").classList.toggle("nowrap", !on);
  try { localStorage.setItem("devboard.logWrap", on ? "1" : "0"); } catch {}
}
setWrap(logWrapped());

function shownLogs() {
  const q = $("#logFilter").value.trim().toLowerCase();
  const active = [...document.querySelectorAll(".lvchip.on")].map((b) => b.dataset.lv);
  return logLines.map((raw, i) => ({ raw, i, lv: classifyLine(raw) })).filter((row) => {
    if (active.length && !active.includes(row.lv) && !(active.includes("info") && row.lv === "other")) return false;
    if (q && !stripAnsi(row.raw).toLowerCase().includes(q)) return false;
    return true;
  });
}
function paintLog() {
  const body = $("#logBody");
  const keepOpen = new Set([...body.querySelectorAll(".log-row.open")].map((r) => r.dataset.i));
  const keepJson = new Set([...body.querySelectorAll(".log-row .json")].map((r) => r.closest(".log-row")?.dataset.i));
  const keepTop = body.scrollTop;
  const q = $("#logFilter").value.trim();
  logShown = shownLogs();
  const counts = { error: 0, warn: 0, info: 0 };
  for (const raw of logLines) {
    const lv = classifyLine(raw);
    if (lv === "error") counts.error++;
    else if (lv === "warn") counts.warn++;
    else if (lv === "info" || lv === "other") counts.info++;
  }
  $("#logNerr").textContent = counts.error;
  $("#logNwarn").textContent = counts.warn;
  $("#logNinfo").textContent = counts.info;
  if (!logShown.length) {
    body.innerHTML = `<div class="note">${logLines.length ? "Nothing matches these filters." : "No lines yet."}</div>`;
  } else {
    body.innerHTML = logShown.map((row) => {
      const { time, body: rest } = splitLogLine(row.raw);
      const json = prettyJson(rest || row.raw);
      const msg = markText(colorizeText(row.raw.includes("\x1b[") ? row.raw : (rest || row.raw)), q);
      return `<div class="log-row lv-${row.lv}" data-i="${row.i}" data-lv="${row.lv}">
        <span class="lvl">${LV_LABEL[row.lv] || "·"}</span>
        <span class="ts" title="${esc(time)}">${esc(time)}</span>
        <span class="msg">${msg}${json ? `<button class="tog" data-act="log-json" style="margin-top:6px">JSON</button>` : ""}</span>
      </div>`;
    }).join("");
  }
  const marks = [...body.querySelectorAll("mark")];
  if (marks.length) {
    logMark = Math.min(logMark, marks.length - 1);
    marks[logMark]?.classList.add("cur");
  }
  $("#logFindCount").textContent = q ? `${marks.length ? logMark + 1 : 0}/${marks.length}` : "0";
  $("#logCount").textContent = `${logShown.length} of ${logLines.length} · ${counts.error} err · ${counts.warn} wrn · ${counts.info} inf`;
  for (const row of body.querySelectorAll(".log-row")) {
    if (keepOpen.has(row.dataset.i)) row.classList.add("open");
    if (keepJson.has(row.dataset.i)) {
      const rec = logShown.find((r) => String(r.i) === row.dataset.i);
      const pretty = rec ? prettyJson(splitLogLine(rec.raw).body || rec.raw) : "";
      if (pretty && !row.querySelector(".json")) {
        const pre = document.createElement("pre");
        pre.className = "json";
        pre.textContent = pretty;
        row.querySelector("[data-act=log-json]")?.after(pre);
      }
    }
  }
  if ($("#logFollow").checked) body.scrollTop = body.scrollHeight;
  else body.scrollTop = keepTop;
}
function jumpMark(dir) {
  const marks = [...$("#logBody").querySelectorAll("mark")];
  if (!marks.length) return;
  marks[logMark]?.classList.remove("cur");
  logMark = (logMark + dir + marks.length) % marks.length;
  marks[logMark].classList.add("cur");
  marks[logMark].closest(".log-row")?.scrollIntoView({ block: "center" });
  $("#logFindCount").textContent = `${logMark + 1}/${marks.length}`;
}
async function renderLog() {
  if (!openLog) return;
  const s = latest.find((x) => x.id === openLog);
  const body = $("#logBody");
  $("#logTitle").textContent = s ? s.name : openLog;
  if (!s) { body.innerHTML = `<div class="note">This service is no longer on the board.</div>`; $("#logMeta").textContent = ""; $("#logCount").textContent = ""; return; }
  if (!s.hasLog) {
    $("#logMeta").textContent = "no output captured";
    $("#logCount").textContent = "";
    body.innerHTML = s.status === "running"
      ? `<div class="note"><strong>${esc(s.name)}</strong> was started from a terminal, so its output is going there. Restart it here to capture the log.<br><button class="ghost" data-act="restart" data-id="${esc(s.id)}">Restart ${esc(s.name)} here</button></div>`
      : `<div class="note"><strong>${esc(s.name)}</strong> has never been started from devboard. Switch it on and its output lands here.</div>`;
    return;
  }
  try {
    const { lines, size } = await api("GET", `/api/logs/${encodeURIComponent(s.id)}?lines=4000`);
    logLines = lines;
    $("#logMeta").textContent = `${size < 1024 ? size + " B" : (size / 1024).toFixed(0) + " KB"}   ~/.devboard/logs/${s.id}.log`;
    paintLog();
  } catch (e) { toast(e.message); }
}
function openPane(id) {
  openLog = id; logLines = []; logShown = []; logMark = 0;
  $("#logFilter").value = ""; $("#logFollow").checked = true;
  $$(".lvchip").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
  $("#logBody").innerHTML = "";
  $("#logs").classList.add("open"); document.body.classList.add("logs-open");
  setWrap(logWrapped());
  renderLog();
}
function closePane() { openLog = null; $("#logs").classList.remove("open"); document.body.classList.remove("logs-open"); }
function copyShown() {
  const text = logShown.map((r) => stripAnsi(r.raw)).join("\n");
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${logShown.length} lines`)).catch(() => toast("Could not copy"));
}
function downloadShown() {
  const text = logShown.map((r) => stripAnsi(r.raw)).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `${openLog || "devboard"}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}
$("#logFilter").oninput = () => { logMark = 0; paintLog(); };
$("#logFollow").onchange = () => { if ($("#logFollow").checked) $("#logBody").scrollTop = $("#logBody").scrollHeight; };
$("#logWrap").onclick = () => setWrap(!logWrapped());
$("#logFindNext").onclick = () => jumpMark(1);
$("#logFindPrev").onclick = () => jumpMark(-1);
$$(".lvchip").forEach((b) => b.onclick = () => {
  b.classList.toggle("on");
  b.setAttribute("aria-pressed", b.classList.contains("on") ? "true" : "false");
  paintLog();
});
$("#logCopy").onclick = copyShown;
$("#logDownload").onclick = downloadShown;
$("#logClear").onclick = async () => {
  if (!openLog) return;
  const s = latest.find((x) => x.id === openLog);
  if (!s?.hasLog) return;
  if (!confirm(`Clear the log file for ${s.name}? This truncates ~/.devboard/logs/${s.id}.log.`)) return;
  try {
    await api("DELETE", `/api/logs/${encodeURIComponent(s.id)}`);
    logLines = [];
    paintLog();
    refresh();
  } catch (e) { toast(e.message); }
};
$("#logBody").addEventListener("scroll", () => {
  const b = $("#logBody");
  const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
  if (!atBottom && $("#logFollow").checked) $("#logFollow").checked = false;
  else if (atBottom && !$("#logFollow").checked) $("#logFollow").checked = true;
});
$("#logBody").addEventListener("click", (ev) => {
  const jsonBtn = ev.target.closest("[data-act=log-json]");
  if (jsonBtn) {
    const row = jsonBtn.closest(".log-row");
    const rec = logShown.find((r) => String(r.i) === row?.dataset.i);
    const pretty = rec ? prettyJson(splitLogLine(rec.raw).body || rec.raw) : "";
    if (!pretty) return;
    const existing = row.querySelector(".json");
    if (existing) existing.remove();
    else {
      const pre = document.createElement("pre");
      pre.className = "json";
      pre.textContent = pretty;
      jsonBtn.after(pre);
    }
    return;
  }
  const row = ev.target.closest(".log-row");
  if (row && !logWrapped()) row.classList.toggle("open");
});
try { const w = Number(localStorage.getItem("devboard.pane")); if (w >= 360) document.documentElement.style.setProperty("--pane", w + "px"); } catch {}
$("#grip").addEventListener("pointerdown", (ev) => {
  const grip = ev.currentTarget; grip.setPointerCapture(ev.pointerId); grip.classList.add("active");
  const move = (e) => document.documentElement.style.setProperty("--pane", Math.max(360, Math.min(window.innerWidth * 0.92, window.innerWidth - e.clientX)) + "px");
  const up = () => { grip.classList.remove("active"); grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); try { localStorage.setItem("devboard.pane", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--pane"))); } catch {} };
  grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
});
document.addEventListener("keydown", (ev) => {
  const typing = ev.target.closest("input, textarea");
  if (ev.key === "Escape") {
    if (openLog && typing === $("#logFilter") && $("#logFilter").value) { $("#logFilter").value = ""; logMark = 0; paintLog(); return; }
    if ($("#envPane").classList.contains("open")) { closeEnv(); return; }
    if (openLog) closePane();
    else if (!$("#addForm").hidden || !$("#projectForm").hidden || !$("#presetForm").hidden) closeForms();
    return;
  }
  if (!openLog) return;
  if (ev.key === "/" && !typing) { ev.preventDefault(); $("#logFilter").focus(); return; }
  if (typing) {
    if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); jumpMark(-1); }
    else if (ev.key === "Enter") { ev.preventDefault(); jumpMark(1); }
    return;
  }
  if (ev.key === "w") setWrap(!logWrapped());
  else if (ev.key === "1") $$(".lvchip")[0]?.click();
  else if (ev.key === "2") $$(".lvchip")[1]?.click();
  else if (ev.key === "3") $$(".lvchip")[2]?.click();
  else if (ev.key === "c" && !ev.metaKey && !ev.ctrlKey) $("#logClear").click();
  else if (ev.key === "n") jumpMark(1);
  else if (ev.key === "N" || ev.key === "p") jumpMark(-1);
});

function paintWt() {
  const prunable = wtStale.filter((w) => w.reason === "prunable");
  $("#wtPruneAll").hidden = prunable.length === 0;
  $("#wtPruneAll").textContent = prunable.length > 1 ? `Prune ${prunable.length} registrations` : "Prune registrations";
  $("#wtCount").textContent = worktrees.length ? `(${worktrees.length})` : "";
  $("#wtInventory").innerHTML = worktrees.length ? worktrees.map((w) => {
    const name = home(w.path).split("/").pop() || w.path;
    const tags = [
      w.main ? `<span class="badge main">main</span>` : "",
      w.dirty ? `<span class="badge dirty">dirty</span>` : "",
      w.locked ? `<span class="badge locked">locked</span>` : "",
      w.detached ? `<span class="badge">detached</span>` : "",
    ].join(" ");
    const ports = w.ports.map((p) => `<a class="port-link mono" href="http://127.0.0.1:${p}" target="_blank" rel="noopener" title="Open http://127.0.0.1:${p}">:${p}</a>`).join(" ");
    return `<article class="card" data-path="${esc(w.path)}">
      <div class="rail" style="background:${w.dirty ? "var(--amber)" : w.main ? "var(--cyan)" : "var(--violet)"}"></div>
      <div class="ready-tag">${esc(w.branch || "detached")} · ${w.diskMb} MB</div>
      <div class="name">${esc(name)}</div>
      <div class="path mono" title="${esc(w.path)}">${esc(home(w.path))}</div>
      <div class="facts">${tags} ${ports || '<span class="mono">no servers</span>'}</div>
      <div class="actions wt-acts">
        <button data-act="wt-open" data-path="${esc(w.path)}">Open</button>
        <button data-act="wt-launch" data-path="${esc(w.path)}">Launch</button>
        ${w.main ? "" : `<button data-act="wt-retire" class="danger" data-path="${esc(w.path)}" data-dirty="${w.dirty ? "1" : ""}" data-locked="${w.locked ? "1" : ""}">Retire</button>`}
      </div>
    </article>`;
  }).join("") : `<p class="empty">Scan a folder to see every git checkout inside it.</p>`;
  $("#staleLabel").hidden = wtStale.length === 0;
  $("#wtList").innerHTML = wtStale.map((w) => {
    const act = w.reason === "prunable"
      ? `<button data-act="wt-prune" data-dir="${esc($("#wt-dir").value)}">Prune</button>`
      : `<button data-act="wt-remove" class="danger" data-path="${esc(w.path)}">Remove folder</button>`;
    return `<div class="wtrow">
      <div><div class="p mono" title="${esc(w.path)}">${esc(home(w.path))}</div><div class="why">${esc(w.detail)}${w.branch ? " · " + esc(w.branch) : ""}</div></div>
      <span class="badge ${esc(w.reason)}">${esc(w.reason)}</span>
      <span class="mono">${esc(home(w.repo).split("/").pop() || "")}</span>
      ${act}
    </div>`;
  }).join("");
}
async function scanWt() {
  const dir = $("#wt-dir").value.trim();
  if (!dir) return;
  $("#wtError").textContent = "";
  $("#wtScan").disabled = true;
  try {
    const data = await api("GET", `/api/worktrees?dir=${encodeURIComponent(dir)}`);
    saveWtDir(dir);
    worktrees = data.worktrees ?? [];
    wtStale = data.stale ?? [];
    paintWt();
  } catch (e) {
    $("#wtError").textContent = e.message;
  } finally {
    $("#wtScan").disabled = false;
  }
}
async function loadAttention() {
  const dir = lastWtDir() || "~/Documents/Personal/Projects";
  try {
    const data = await api("GET", `/api/attention?dir=${encodeURIComponent(dir)}`);
    alerts = data.alerts ?? [];
    $("#alerts").innerHTML = alerts.length ? alerts.map((a) => `<article class="alert" data-id="${esc(a.serviceId || "")}" data-path="${esc(a.path || "")}">
      <span class="badge kind">${esc(a.kind.replace("-", " "))}</span>
      <div><strong>${esc(a.title)}</strong><p>${esc(a.detail)}</p></div>
      <div class="wt-acts">
        ${a.serviceId ? `<button data-act="logs" data-id="${esc(a.serviceId)}">Logs</button>` : ""}
        ${a.path ? `<button data-act="wt-open" data-path="${esc(a.path)}">Open</button>` : ""}
      </div>
    </article>`).join("") : `<p class="empty">Quiet. No port fights, crashes, dirty review trees, or oversized logs.</p>`;
    paintStatus();
  } catch (e) {
    $("#alerts").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function switchAll(on) {
  const targets = latest.filter((s) => s.kind === "dev" && !s.hidden && (on ? s.status === "stopped" : s.status === "running"));
  if (!targets.length) return;
  if (!on && !confirm(`Switch off ${targets.length} running dev server${targets.length > 1 ? "s" : ""}? Unsaved ones get pinned first so you can switch them back on.`)) return;
  for (const s of targets) setBusy(s.id, on ? "starting" : "stopping");
  render();
  for (const s of targets) {
    try {
      if (on) await api("POST", "/api/start", { id: s.id });
      else { if (!s.pinned) await api("POST", "/api/pin", { rootPid: s.rootPid }); await api("POST", "/api/kill", { rootPid: s.rootPid }); }
    } catch (e) { busy.delete(s.id); toast(`${s.name}: ${e.message}`); }
  }
  refresh(); refreshSoon();
}
$("#startAll").onclick = () => switchAll(true);
$("#stopAll").onclick = () => switchAll(false);

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const holder = btn.closest("[data-id]");
  const id = btn.dataset.id || holder?.dataset.id;
  const s = latest.find((x) => x.id === id);
  btn.disabled = true;
  try {
    if (act === "toggle" && s) {
      if (s.status === "running") {
        setBusy(id, "stopping");
        if (!s.pinned) await api("POST", "/api/pin", { rootPid: s.rootPid });
        await api("POST", "/api/kill", { rootPid: s.rootPid });
      } else {
        setBusy(id, "starting");
        await api("POST", "/api/start", { id });
      }
    } else if (act === "restart" && s) {
      setBusy(id, "starting");
      await api("POST", "/api/restart", s.rootPid ? { rootPid: s.rootPid } : { id });
    } else if (act === "pin" && s) {
      await api("POST", "/api/pin", { rootPid: s.rootPid });
    } else if (act === "env" && s) {
      openEnv(s);
    } else if (act === "edit" && s) {
      showTab("board"); openForm(s);
    } else if (act === "remove" && s) {
      await api("DELETE", `/api/pin/${encodeURIComponent(id)}`);
    } else if (act === "logs") {
      if (s || id) openPane(id);
    } else if (act === "hide" && s) {
      await api("POST", "/api/ignore", { id });
      if (openLog === id) closePane();
    } else if (act === "unhide" && s) {
      await api("DELETE", `/api/ignore/${encodeURIComponent(id)}`);
    } else if (act === "kill-sys") {
      const name = holder?.dataset.name || "this process";
      if (confirm(`Kill ${name}? It is a system process and macOS may restart it.`)) await api("POST", "/api/kill", { rootPid: Number(btn.dataset.root) });
    } else if (act === "wt-prune") {
      await api("POST", "/api/worktrees/prune", { dir: btn.dataset.dir || $("#wt-dir").value });
      await scanWt();
    } else if (act === "wt-remove") {
      if (!confirm(`Delete ${home(btn.dataset.path)}? It is an orphaned worktree folder, not a git repository.`)) { btn.disabled = false; return; }
      await api("POST", "/api/worktrees/remove", { path: btn.dataset.path });
      await scanWt();
    } else if (act === "wt-open") {
      await api("POST", "/api/open", { path: btn.dataset.path });
    } else if (act === "wt-launch") {
      const result = await api("POST", "/api/worktrees/launch", { path: btn.dataset.path });
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
      if (!(result.started ?? []).length) {
        showTab("board");
        openForm(null);
        $("#f-cwd").value = btn.dataset.path;
        $("#f-port").value = result.port;
        loadSuggest(btn.dataset.path);
        toast("No pinned servers in that checkout — add one on a free port.");
      }
    } else if (act === "wt-retire") {
      const forceNeeded = btn.dataset.dirty === "1" || btn.dataset.locked === "1";
      if (!confirm(forceNeeded
        ? `Retire ${home(btn.dataset.path)}? It is dirty or locked. This force-removes the checkout.`
        : `Retire ${home(btn.dataset.path)}? The branch stays in the repo.`)) { btn.disabled = false; return; }
      try {
        await api("POST", "/api/worktrees/retire", { path: btn.dataset.path, force: forceNeeded });
      } catch (e) {
        if (!forceNeeded && /uncommitted|locked/i.test(e.message) && confirm(`${e.message}. Force retire?`)) {
          await api("POST", "/api/worktrees/retire", { path: btn.dataset.path, force: true });
        } else throw e;
      }
      await scanWt();
    } else if (act === "group") {
      await api("POST", `/api/projects/${encodeURIComponent(btn.dataset.project)}/members`, { id });
    } else if (act === "ungroup") {
      const projectId = btn.closest(".project")?.dataset.id;
      if (projectId) await api("DELETE", `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id)}`);
    } else if (act === "project-start") {
      const projectId = holder.dataset.id;
      for (const mid of (projects.find((p) => p.id === projectId)?.memberIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "stopped") setBusy(mid, "starting");
      }
      render();
      const result = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/start`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
    } else if (act === "project-stop") {
      if (!confirm(`Stop every running server in ${holder.dataset.name}?`)) { btn.disabled = false; return; }
      const projectId = holder.dataset.id;
      for (const mid of (projects.find((p) => p.id === projectId)?.memberIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "running") setBusy(mid, "stopping");
      }
      render();
      const result = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/stop`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
    } else if (act === "project-folder") {
      await api("POST", `/api/projects/${encodeURIComponent(holder.dataset.id)}/members`, { folder: holder.dataset.folder });
    } else if (act === "project-edit") {
      openProjectForm(projects.find((p) => p.id === holder.dataset.id));
    } else if (act === "project-delete") {
      if (!confirm(`Remove project ${holder.dataset.name}? The servers stay on the board.`)) { btn.disabled = false; return; }
      await api("DELETE", `/api/projects/${encodeURIComponent(holder.dataset.id)}`);
    } else if (act === "preset-run") {
      const result = await api("POST", `/api/presets/${encodeURIComponent(id)}/resume`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
      for (const mid of (presets.find((p) => p.id === id)?.serviceIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "stopped") setBusy(mid, "starting");
      }
      for (const url of result.urls ?? []) {
        try { window.open(url, "_blank", "noopener"); } catch {}
      }
    } else if (act === "preset-del") {
      if (!confirm(`Remove preset ${holder.dataset.id}?`)) { btn.disabled = false; return; }
      await api("DELETE", `/api/presets/${encodeURIComponent(id)}`);
    }
  } catch (e) {
    if (id) busy.delete(id);
    toast(e.message);
  } finally {
    btn.disabled = false;
    render();
    refresh();
    if (["toggle", "restart", "project-start", "project-stop", "preset-run", "wt-launch"].includes(act)) refreshSoon();
  }
});

$("#logClose").onclick = closePane;
$("#addBtn").onclick = () => { showTab("board"); $("#addForm").hidden ? openForm(null) : closeForms(); };
$("#projectBtn").onclick = () => { showTab("board"); $("#projectForm").hidden ? openProjectForm(null) : closeForms(); };
$("#presetBtn").onclick = () => { showTab("board"); $("#presetForm").hidden ? openPresetForm() : closeForms(); };
$("#envClose").onclick = closeEnv;
$("#envPane").onclick = (ev) => { if (ev.target === $("#envPane")) closeEnv(); };
$("#f-cwd").addEventListener("blur", () => loadSuggest($("#f-cwd").value));
$("#f-suggest").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".suggest");
  if (!btn) return;
  $("#f-cmd").value = btn.dataset.cmd || "";
  if (btn.dataset.port) $("#f-port").value = btn.dataset.port;
});
$("#addCancel").onclick = closeForms;
$("#projectCancel").onclick = closeForms;
$("#presetCancel").onclick = closeForms;
$("#projectForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  const body = { name: data.name, folder: data.folder, links: data.links, addFromFolder: f.elements.addFromFolder.checked };
  try {
    if (editingProjectId) await api("PUT", `/api/projects/${encodeURIComponent(editingProjectId)}`, body);
    else await api("POST", "/api/projects", body);
    closeForms();
    refresh();
  } catch (e) { $("#projectError").textContent = e.message; }
};
$("#presetForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  const serviceIds = [...f.querySelectorAll("input[name=serviceId]:checked")].map((el) => el.value);
  try {
    await api("POST", "/api/presets", {
      name: data.name,
      serviceIds,
      urls: data.urls,
      worktree: data.worktree || undefined,
      openEditor: f.elements.openEditor.checked,
    });
    closeForms();
    refresh();
  } catch (e) { $("#presetError").textContent = e.message; }
};
document.addEventListener("change", async (ev) => {
  const sel = ev.target.closest("select[data-act=group-select]");
  if (!sel || !sel.value) return;
  const id = sel.closest("[data-id]")?.dataset.id;
  try { await api("POST", `/api/projects/${encodeURIComponent(sel.value)}/members`, { id }); }
  catch (e) { toast(e.message); }
  refresh();
});
$("#wtForm").onsubmit = async (ev) => { ev.preventDefault(); await scanWt(); };
$("#wtPruneAll").onclick = async () => {
  try {
    await api("POST", "/api/worktrees/prune", { dir: $("#wt-dir").value });
    await scanWt();
  } catch (e) { $("#wtError").textContent = e.message; }
};
$("#wtCreate").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target));
  $("#wtCreateError").textContent = "";
  try {
    const created = await api("POST", "/api/worktrees/create", { repo: data.repo, branch: data.branch, path: data.path || undefined });
    ev.target.reset();
    toast(`Created ${home(created.path)}`);
    if (!$("#wt-dir").value) $("#wt-dir").value = lastWtDir() || data.repo;
    await scanWt();
  } catch (e) { $("#wtCreateError").textContent = e.message; }
};
$("#addForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  const body = { name: data.name, cwd: data.cwd, command: data.command, port: Number(data.port), healthUrl: data.healthUrl, envText: data.envText, restartOnCrash: f.elements.restartOnCrash.checked };
  try {
    if (editingId) await api("PUT", `/api/pinned/${encodeURIComponent(editingId)}`, body);
    else await api("POST", "/api/pinned", body);
    closeForms();
    refresh();
  } catch (e) { $("#formError").textContent = e.message; }
};

refresh();
setInterval(refresh, 3000);
setInterval(renderLog, 2000);
