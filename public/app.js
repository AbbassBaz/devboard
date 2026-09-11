const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const home = (p) => (p ? p.replace(/^\/Users\/[^/]+/, "~") : "");
const nowClock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const RE_MARK = /^===|^\$ |^> /;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOG_TS = /^(\s*(?:\[[^\]]{6,32}\]|\d{4}-\d{2}-\d{2}[T ][\d:.Z+-]+|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*)/;

let latest = [];
let projects = [];
let presets = [];
let alerts = [];
let worktrees = [];
let wtStale = [];
const busy = {};
const logs = {};
let sel = null;
let query = "";
let logFilter = "";
let errOnly = false;
let follow = true;
let errCursor = null;
let menu = null;
let addOpen = false;
let toastText = "";
let editingId = null;
let editingProjectId = null;
let clock = nowClock();
let toastTimer = 0;
let lastLogSig = "";

try { sel = localStorage.getItem("devboard.sel"); } catch {}

function lastWtDir() {
  try { return localStorage.getItem("devboard.worktreesDir") || ""; } catch { return ""; }
}
function saveWtDir(dir) {
  try { localStorage.setItem("devboard.worktreesDir", dir); } catch {}
}
function saveSel(id) {
  sel = id;
  try { if (id) localStorage.setItem("devboard.sel", id); } catch {}
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, copied = false) {
  toastText = msg ? { text: String(msg), copied } : "";
  paintToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText = ""; paintToast(); }, 1600);
}
function copy(text) {
  const t = String(text ?? "");
  navigator.clipboard.writeText(t).then(() => toast(t, true)).catch(() => toast("could not copy"));
}
function paintToast() {
  const el = $("#toast");
  el.hidden = !toastText;
  if (!toastText) { el.textContent = ""; return; }
  el.innerHTML = toastText.copied
    ? `copied · <span class="d">${esc(toastText.text)}</span>`
    : esc(toastText.text);
}

function closeMenu() { if (menu) { menu = null; paintMenus(); } }
function setMenu(name, ev) {
  if (ev) ev.stopPropagation();
  menu = menu === name ? null : name;
  paintMenus();
}
function paintMenus() {
  $("#topMenu").hidden = menu !== "top";
  const logMenu = $("#logMenu");
  if (logMenu) logMenu.hidden = menu !== "log";
}

function overlayOpen() { return !$("#overlay").hidden; }
function hideSheets() {
  $("#overlay").hidden = true;
  $$("#overlay .sheet").forEach((el) => { el.hidden = true; });
}
function closeSheet() {
  hideSheets();
  editingId = null;
  editingProjectId = null;
}
function openSheet(id) {
  closeMenu();
  hideSheets();
  $("#overlay").hidden = false;
  $(`#${id}`).hidden = false;
}

function stripAnsi(s) { return String(s ?? "").replace(ANSI_RE, ""); }
function lineKind(level, text) {
  if (level === "error") return "err";
  if (level === "warn") return "warn";
  if (RE_MARK.test(stripAnsi(text))) return "mark";
  if (level === "info") return "ok";
  return "";
}
function isLogErr(entry) { return (typeof entry === "object" ? entry.level : null) === "error"; }
function logText(entry) { return typeof entry === "string" ? entry : (entry?.text ?? ""); }
function splitLogLine(raw) {
  const text = stripAnsi(raw);
  const m = LOG_TS.exec(text);
  return m ? { time: m[1].trim(), body: text.slice(m[0].length) } : { time: "", body: text };
}
function formatLogTime(t) {
  if (!t) return "";
  const iso = Date.parse(t);
  if (!Number.isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(t)) {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  const m = t.match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : t;
}
function errTotal() {
  return latest.filter((s) => s.kind === "dev" && !s.hidden).reduce((n, s) => n + (s.errorCount ?? 0), 0);
}

function formatEnv(env) {
  if (!env || !Object.keys(env).length) return "";
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
}
function envBlock(env) {
  const keys = Object.keys(env || {}).sort();
  if (!keys.length) return "none";
  return keys.map((k) => `${k}=${env[k]}`).join("\n");
}

function setBusy(id, state) { busy[id] = { state, at: Date.now() }; }
function clearBusy(id) { delete busy[id]; }
function sweepBusy() {
  for (const [id, { state, at }] of Object.entries(busy)) {
    const s = latest.find((x) => x.id === id);
    const settled = (state === "starting" && (s?.status === "running" || s?.status === "starting")) || (state === "stopping" && (!s || s.status === "stopped"));
    if (settled || Date.now() - at > 15000) delete busy[id];
  }
}
function rowState(s) {
  const b = busy[s.id]?.state;
  if (b) return "busy";
  if (s.status === "starting") return "busy";
  return s.status === "running" ? "on" : "off";
}
function isUnhealthy(s) {
  return s.status === "running" && s.readiness === "unhealthy";
}
function healthNote(s) {
  if (!isUnhealthy(s)) return "";
  if (s.health?.status != null) return `health ${s.health.status} · ${s.health.ms}ms`;
  if (s.health?.error) return `health ${s.health.error}`;
  return "unhealthy";
}
function portOf(s) { return s.ports?.[0]; }
function runCmd(s) { return `cd ${s.cwd || "."} && ${s.command || ""}`; }

function visible() {
  const q = query.trim().toLowerCase();
  return latest.filter((s) => {
    if (s.kind !== "dev" || s.hidden || !s.id) return false;
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.ports.some((p) => String(p).includes(q));
  });
}

function ensureSel() {
  const ids = visible().map((s) => s.id);
  const all = latest.filter((s) => s.kind === "dev" && !s.hidden && s.id).map((s) => s.id);
  if (sel && (ids.includes(sel) || all.includes(sel))) return;
  saveSel(ids[0] || all[0] || null);
}

function selected() { return latest.find((s) => s.id === sel) || null; }

function optimisticStartLines(s) {
  const cmd = s.command || "";
  return [`=== devboard start · ${cmd}`, `$ ${cmd}`];
}

function appendStartLines(s) {
  logs[s.id] = [...(logs[s.id] || []), ...optimisticStartLines(s).map((text) => ({ text, level: "other" }))];
}

async function loadSuggest(dir, boxId, cmdId, portId) {
  const box = $(boxId);
  if (!dir?.trim()) { box.hidden = true; box.innerHTML = ""; return; }
  try {
    const { suggestions } = await api("GET", `/api/suggest?dir=${encodeURIComponent(dir.trim())}`);
    if (!suggestions?.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = suggestions.map((s) =>
      `<button type="button" class="suggest" data-cmd="${esc(s.command)}" data-port="${s.port ?? ""}">${esc(s.label)} <span class="mono">${esc(s.command)}${s.port ? " · :" + s.port : ""}</span></button>`
    ).join("");
    box.dataset.cmd = cmdId;
    box.dataset.port = portId;
  } catch {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function paintClock() {
  clock = nowClock();
  $("#clock").textContent = clock;
}
function paintChrome() {
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden);
  const nUp = dev.filter((s) => s.status === "running").length;
  const nBusy = dev.filter((s) => busy[s.id]).length;
  const nDown = Math.max(0, dev.length - nUp - nBusy);
  const nErr = errTotal();
  const nUnhealthy = dev.filter(isUnhealthy).length;
  $("#counts").innerHTML =
    `<span><span class="n">${nUp}</span> up</span>` +
    `<span class="${nDown ? "hot" : ""}">${nDown} down</span>` +
    `<span class="${nErr ? "err" : ""}">${nErr} err</span>` +
    `<span class="${nUnhealthy ? "err" : ""}">${nUnhealthy} unhealthy</span>`;
  $("#poll").textContent = `poll 3s · ${location.host || "127.0.0.1:4242"}`;
}

function paintList() {
  const grouped = new Set(projects.flatMap((p) => p.memberIds));
  const rows = visible();
  const parts = [];
  for (const p of projects) {
    const members = rows.filter((s) => p.memberIds.includes(s.id));
    if (!members.length && query.trim()) continue;
    const on = members.filter((s) => s.status === "running").length;
    const ports = [...new Set((p.ports ?? []).concat(members.flatMap((s) => s.ports)))].sort((a, b) => a - b);
    const links = [
      ...ports.map((port) => `<a class="port" href="http://localhost:${port}" target="_blank" rel="noopener" data-act="open-port">:${port}</a>`),
      ...(p.links ?? []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`),
    ].join("");
    parts.push(`<div class="g-head">
      <span class="g-label">${esc(p.name)}</span>
      <span class="mono">${on}/${members.length}</span>
      ${links ? `<span class="g-links">${links}</span>` : ""}
      <span class="g-acts">
        <button type="button" class="start" data-act="project-start" data-id="${esc(p.id)}">start</button>
        <button type="button" class="stop" data-act="project-stop" data-id="${esc(p.id)}" data-name="${esc(p.name)}">stop</button>
        <button type="button" data-act="project-edit" data-id="${esc(p.id)}">edit</button>
      </span>
    </div>${members.map(rowHtml).join("") || `<p class="empty-note" style="padding:4px 12px">No servers in this project.</p>`}`);
  }
  const other = rows.filter((s) => !grouped.has(s.id));
  if (other.length || (!projects.length && !rows.length)) {
    if (projects.length) {
      parts.push(`<div class="g-head"><span class="g-label">Other</span><span class="mono">${other.filter((s) => s.status === "running").length}/${other.length}</span></div>`);
    }
    parts.push(other.map(rowHtml).join("") || (projects.length ? "" : `<p class="empty-note" style="padding:12px">Nothing running. Start a server from a terminal, or add one and switch it on.</p>`));
  }
  $("#dev").innerHTML = parts.join("");

  const sys = latest.filter((s) => s.kind === "system");
  $("#sysCount").textContent = `${sys.length} listener${sys.length === 1 ? "" : "s"}`;
  $("#sysList").innerHTML = sys.map((s) => `<div class="sysrow" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
    <span class="dot hollow"></span>
    <span class="sys-main"><span class="n">${esc(s.name)} <span class="p">${s.ports.map((p) => ":" + p).join(" ")}</span></span><span class="c" title="${esc(s.command)}">${esc(s.command)}</span></span>
    <button type="button" data-act="kill-sys" data-root="${s.rootPid}">kill</button>
  </div>`).join("");

  const hidden = latest.filter((s) => s.kind === "dev" && s.hidden);
  $("#hiddenSec").hidden = hidden.length === 0;
  $("#hiddenCount").textContent = String(hidden.length);
  $("#hiddenList").innerHTML = hidden.map((s) => `<div class="hiddenrow" data-id="${esc(s.id)}">
    <span class="n">${esc(s.name)}</span><span>${s.ports.map((p) => ":" + p).join("  ")}</span>
    <button type="button" data-act="unhide">Show</button>
  </div>`).join("");
}

function rowHtml(s) {
  const state = rowState(s);
  const b = busy[s.id]?.state;
  const port = portOf(s);
  const cpu = s.cpu ?? 0;
  const errs = s.errorCount ?? 0;
  const barW = state === "on" ? Math.round(Math.max(Math.min(cpu / 6, 1), cpu ? 0.04 : 0) * 100) : 0;
  const note = healthNote(s);
  const meta = state === "on"
    ? `pid ${s.rootPid} · ${cpu.toFixed(1)}% · ${s.memMb ?? 0} MB · up ${s.uptime || ""}${note ? ` · ${note}` : ""}`
    : state === "busy"
      ? `${b || "starting"}… waiting for :${port ?? "—"}`
      : s.exitCode != null ? `stopped · exit ${s.exitCode}` : s.pinned ? "stopped · saved" : "stopped";
  const switchLabel = state === "busy" ? (b || "starting") : s.status === "running" ? `Stop ${s.name}` : `Start ${s.name}`;
  const crashPill = s.crash?.gaveUp ? `<span class="err-pill">restart failed ×5</span>` : "";
  return `<div class="row ${state}${sel === s.id ? " sel" : ""}" data-id="${esc(s.id)}" data-act="select">
    <span class="dot ${state}${isUnhealthy(s) ? " bad" : ""}" title="${isUnhealthy(s) ? "unhealthy" : ""}"></span>
    <span class="row-main">
      <span class="row-name"><span class="n">${esc(s.name)}</span>${port ? `<a class="port" href="http://localhost:${port}" target="_blank" rel="noopener" data-act="open-port">:${port}</a>` : ""}</span>
      <span class="row-meta">${esc(meta)}</span>
    </span>
    <span class="row-right">
      ${crashPill}${errs ? `<span class="err-pill">${errs}</span>` : ""}
      <span class="bar"><i class="${cpu > 4.5 ? "hot" : ""}" style="width:${barW}%"></i></span>
    </span>
    <button class="sw ${state}" role="switch" aria-checked="${s.status === "running"}" title="${esc(switchLabel)}" data-act="toggle" ${b ? "disabled" : ""}><span class="knob"></span></button>
  </div>`;
}

function logMenuItems(s) {
  if (!s) return [];
  const inProject = projects.find((p) => p.memberIds.includes(s.id));
  const items = [
    { label: "Open in browser", key: "o", act: "open-browser" },
    { label: "Open in editor", key: "", act: "open-editor" },
    { label: "Copy run command", key: "c", act: "copy-run" },
    { sep: true },
    { label: errOnly ? "Show all lines" : "Show errors only", key: "", act: "toggle-err-only" },
    { label: follow ? "Stop following" : "Follow new lines", key: "", act: "toggle-follow" },
    { label: "Clear log", key: "", act: "clear-log" },
    { sep: true },
  ];
  if (s.status === "running" && !s.pinned) items.push({ label: "Pin", key: "", act: "pin" });
  if (s.pinned) items.push({ label: "Edit…", key: "", act: "edit" });
  items.push({ label: "Env…", key: "", act: "env" });
  if (inProject) items.push({ label: `Remove from ${inProject.name}`, key: "", act: "ungroup", project: inProject.id });
  else {
    for (const p of projects) items.push({ label: `Add to ${p.name}`, key: "", act: "group", project: p.id });
  }
  items.push({ label: "Hide", key: "", act: "hide" });
  if (s.pinned) items.push({ label: "Remove", key: "", act: "remove", danger: true });
  return items;
}

function paintLogHead() {
  const s = selected();
  const a = $("#logA");
  const b = $("#logB");
  if (!s) {
    a.innerHTML = `<span class="name">Logs</span><span class="state">no server selected</span>`;
    b.innerHTML = "";
    return;
  }
  const state = rowState(s);
  const bsy = busy[s.id]?.state;
  const port = portOf(s);
  const stateLabel = isUnhealthy(s) ? "unhealthy" : state === "on" ? "running" : state === "busy" ? (bsy || "starting") : "stopped";
  const primaryLabel = state === "busy" ? `${bsy || "starting"}…` : state === "on" ? "Restart" : "Start";
  const primaryClass = state === "busy" ? "busy" : state === "on" ? "restart" : "";
  const items = logMenuItems(s);
  a.innerHTML = `
    <span class="dot ${state}${isUnhealthy(s) ? " bad" : ""}" title="${isUnhealthy(s) ? "unhealthy" : ""}"></span>
    <span class="name">${esc(s.name)}</span>
    ${port ? `<a class="host" href="http://localhost:${port}" target="_blank" rel="noopener">localhost:${port} ↗</a>` : ""}
    <span class="state">${esc(stateLabel)}</span>
    <span class="log-acts">
      <button type="button" class="primary-go ${primaryClass}" data-act="primary" ${state === "busy" ? "disabled" : ""}>${esc(primaryLabel)}</button>
      <button type="button" class="icon-btn" id="logMenuBtn" title="More">···</button>
      <div class="menu log" id="logMenu" ${menu === "log" ? "" : "hidden"}>
        ${items.map((m) => m.sep
          ? `<span class="menu-sep"></span>`
          : `<button type="button" data-act="${esc(m.act)}" ${m.project ? `data-project="${esc(m.project)}"` : ""} class="${m.danger ? "danger" : ""}"><span>${esc(m.label)}</span><span class="k">${esc(m.key || "")}</span></button>`
        ).join("")}
      </div>
    </span>`;
  const cwd = home(s.cwd) || "—";
  const cmd = s.command || "—";
  const live = state === "on"
    ? `<span class="live">pid ${s.rootPid} · ${(s.cpu ?? 0).toFixed(1)}% · ${s.memMb ?? 0} MB · up ${s.uptime || ""}</span>`
    : "";
  b.innerHTML = `
    <button type="button" data-act="copy-cwd" title="Copy path"><span class="g">cwd</span><span class="v">${esc(cwd)}</span></button>
    <button type="button" data-act="copy-cmd" title="Copy command"><span class="g">$</span><span class="v">${esc(cmd)}</span></button>
    ${live}`;
  $("#logMenuBtn")?.addEventListener("click", (ev) => setMenu("log", ev));
}

function shownLogs(s) {
  const raw = (s && logs[s.id]) || [];
  const q = logFilter.trim().toLowerCase();
  return raw.map((entry, i) => ({ raw: logText(entry), i, text: stripAnsi(logText(entry)), level: entry.level }))
    .filter((l) => (!q || l.text.toLowerCase().includes(q)) && (!errOnly || l.level === "error"));
}

function paintLogTools(s) {
  const raw = (s && logs[s.id]) || [];
  const errIdx = raw.map((l, i) => (isLogErr(l) ? i : -1)).filter((i) => i >= 0);
  const shown = shownLogs(s);
  const chip = $("#errChip");
  chip.hidden = !s || errIdx.length === 0;
  chip.classList.toggle("on", errOnly);
  if (errIdx.length) {
    const label = errOnly
      ? `errors only · ${errIdx.length}`
      : errCursor == null
        ? `${errIdx.length} ${errIdx.length === 1 ? "error" : "errors"} ↓`
        : `error ${errIdx.indexOf(errCursor) + 1}/${errIdx.length} ↓`;
    chip.innerHTML = `<span class="d"></span>${esc(label)}`;
  }
  $("#followBtn").hidden = follow;
  const filtered = !!(logFilter.trim() || errOnly);
  $("#logCount").textContent = s ? (filtered ? `${shown.length}/${raw.length} lines` : `${raw.length} lines`) : "";
  $("#logCount").title = s ? `~/.devboard/logs/${s.id}.log` : "";
}

function paintLogBody(s) {
  const body = $("#logBody");
  if (!s) {
    body.innerHTML = `<div class="empty">Select a server to read its output.</div>`;
    lastLogSig = "";
    return;
  }
  const raw = logs[s.id] || [];
  const shown = shownLogs(s);
  const unmanaged = s.status === "running" && !s.hasLog && !raw.length;
  const filteredEmpty = raw.length && !shown.length;
  const sig = [s.id, raw.length, logText(raw.at(-1) ?? ""), logFilter, errOnly, errCursor, s.status, rowState(s), follow].join("|");
  if (sig === lastLogSig) {
    if (follow) body.scrollTop = body.scrollHeight;
    return;
  }
  lastLogSig = sig;

  if (!shown.length) {
    let text = "Nothing matches the current filter.";
    let startBtn = "";
    if (filteredEmpty) text = "Nothing matches the current filter.";
    else if (unmanaged) {
      text = "Started outside devboard — output is going to that terminal. Restart it here to capture logs.";
    } else if (s.status !== "running") {
      text = `${s.name} is stopped. Start it and its output lands here.`;
      startBtn = `<button type="button" class="go" data-act="toggle">Start ${esc(s.name)}</button>`;
    } else {
      body.innerHTML = rowState(s) === "on" ? `<div class="caret"><span style="width:30px"></span><i></i></div>` : "";
      if (follow) body.scrollTop = body.scrollHeight;
      return;
    }
    body.innerHTML = `<div class="empty"><span>${esc(text)}</span>${startBtn}</div>`;
    return;
  }

  const times = shown.map((l) => formatLogTime(splitLogLine(l.raw).time));
  const showTime = times.some(Boolean);
  body.innerHTML = shown.map((l) => {
    const { time, body: rest } = splitLogLine(l.raw);
    const kind = lineKind(l.level, l.text);
    const t = formatLogTime(time);
    const display = (rest || l.text) || l.text;
    return `<div class="log-line ${kind}${errCursor === l.i ? " cur" : ""}" data-i="${l.i}" id="log-${esc(s.id)}-${l.i}" title="Click to copy line">
      <span class="ln">${l.i + 1}</span>
      ${showTime ? `<span class="t">${esc(t)}</span>` : ""}
      <span>${esc(display)}</span>
    </div>`;
  }).join("") + (rowState(s) === "on" ? `<div class="caret"><span style="width:30px"></span><i></i></div>` : "");

  if (follow) body.scrollTop = body.scrollHeight;
}

function paintLog() {
  const s = selected();
  paintLogHead();
  paintLogTools(s);
  paintLogBody(s);
}

function render() {
  sweepBusy();
  ensureSel();
  paintChrome();
  paintList();
  paintLog();
  paintMenus();
}

function select(id) {
  if (!id || sel === id) { saveSel(id); paintList(); return; }
  saveSel(id);
  errCursor = null;
  lastLogSig = "";
  paintList();
  paintLog();
  if (follow) $("#logBody").scrollTop = $("#logBody").scrollHeight;
  fetchLog(id);
}

function nextErr() {
  const s = selected();
  if (!s) return;
  const raw = logs[s.id] || [];
  const idx = raw.map((l, i) => (isLogErr(l) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  const cur = errCursor == null ? -1 : errCursor;
  const next = idx.find((i) => i > cur) ?? idx[0];
  errCursor = next;
  follow = false;
  lastLogSig = "";
  paintLog();
  const c = $("#logBody");
  const el = document.getElementById(`log-${s.id}-${next}`);
  if (c && el) c.scrollTop = el.offsetTop - c.offsetTop - Math.min(80, c.clientHeight / 3);
}

function moveSel(dir) {
  const ids = visible().map((s) => s.id);
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(sel));
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + dir))];
  select(next);
  const el = document.querySelector(`.row.sel`);
  el?.scrollIntoView({ block: "nearest" });
}

async function toggle(s) {
  if (!s || busy[s.id]) return;
  try {
    if (s.status === "running" || s.status === "starting") {
      setBusy(s.id, "stopping");
      render();
      if (!s.pinned) await api("POST", "/api/pin", { rootPid: s.rootPid });
      await api("POST", "/api/kill", { rootPid: s.rootPid });
    } else {
      setBusy(s.id, "starting");
      appendStartLines(s);
      lastLogSig = "";
      render();
      await api("POST", "/api/start", { id: s.id });
    }
  } catch (e) {
    clearBusy(s.id);
    toast(e.message);
  }
  refresh();
  refreshSoon();
}

async function restart(s) {
  if (!s || busy[s.id]) return;
  setBusy(s.id, "starting");
  appendStartLines(s);
  lastLogSig = "";
  render();
  try {
    await api("POST", "/api/restart", s.rootPid ? { rootPid: s.rootPid } : { id: s.id });
  } catch (e) {
    clearBusy(s.id);
    toast(e.message);
  }
  refresh();
  refreshSoon();
}

async function switchAll(on) {
  closeMenu();
  const targets = latest.filter((s) => s.kind === "dev" && !s.hidden && (on ? s.status === "stopped" : s.status === "running"));
  if (!targets.length) return;
  if (!on && !confirm(`Switch off ${targets.length} running dev server${targets.length > 1 ? "s" : ""}? Unsaved ones get pinned first so you can switch them back on.`)) return;
  for (const s of targets) {
    setBusy(s.id, on ? "starting" : "stopping");
    if (on) appendStartLines(s);
  }
  lastLogSig = "";
  render();
  for (const s of targets) {
    try {
      if (on) await api("POST", "/api/start", { id: s.id });
      else {
        if (!s.pinned) await api("POST", "/api/pin", { rootPid: s.rootPid });
        await api("POST", "/api/kill", { rootPid: s.rootPid });
      }
    } catch (e) { clearBusy(s.id); toast(`${s.name}: ${e.message}`); }
  }
  refresh();
  refreshSoon();
}

function toggleAdd() {
  addOpen = !addOpen;
  $("#addForm").hidden = !addOpen;
  if (addOpen) {
    $("#addForm").reset();
    $("#a-suggest").hidden = true;
    $("#addError").textContent = "";
    $("#a-name").focus();
  }
}

function openEdit(s) {
  editingId = s.id;
  const f = $("#editForm");
  f.reset();
  $("#f-suggest").hidden = true;
  f.elements.name.value = s.name;
  f.elements.cwd.value = s.cwd ?? "";
  f.elements.command.value = s.command ?? "";
  f.elements.port.value = s.ports[0] ?? "";
  f.elements.healthUrl.value = s.healthUrl ?? "";
  f.elements.envText.value = formatEnv(s.env);
  f.elements.restartOnCrash.checked = !!s.restartOnCrash;
  $("#formTitle").textContent = `Edit ${s.name}`;
  $("#formError").textContent = "";
  loadSuggest(s.cwd, "#f-suggest", "#f-cmd", "#f-port");
  openSheet("sheet-edit");
}

function openProjectForm(p) {
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
  $("#projectError").textContent = "";
  paintProjectList();
  openSheet("sheet-project");
}

function paintProjectList() {
  const el = $("#projectList");
  if (!projects.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h3 class="sub">Projects</h3>` + projects.map((p) => `<div class="proj-row" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-folder="${esc(p.folder ?? "")}">
    <strong>${esc(p.name)}</strong>
    <span class="mono">${p.on} on · ${p.off} off</span>
    ${p.folder ? `<button type="button" data-act="project-folder">Add from folder</button>` : ""}
    <button type="button" data-act="project-edit">Edit</button>
    <button type="button" class="danger" data-act="project-delete">Remove</button>
  </div>`).join("");
}

function openPresetForm() {
  const f = $("#presetForm");
  f.reset();
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden && s.id);
  $("#pr-services").innerHTML = dev.length
    ? dev.map((s) => `<label class="check"><input type="checkbox" name="serviceId" value="${esc(s.id)}" ${s.status === "running" ? "checked" : ""}> ${esc(s.name)} <span class="mono">:${s.ports[0] ?? "—"}</span></label>`).join("")
    : `<p class="empty-note">Pin a server first, then save it here.</p>`;
  f.elements.urls.value = dev.filter((s) => s.status === "running" && s.ports[0]).map((s) => `http://127.0.0.1:${s.ports[0]}`).join("\n");
  $("#presetError").textContent = "";
  paintPresets();
  openSheet("sheet-preset");
}

function paintPresets() {
  const el = $("#presets");
  if (!presets.length) {
    el.innerHTML = `<p class="empty-note">No resume presets yet.</p>`;
    return;
  }
  el.innerHTML = presets.map((p) => `<div class="preset" data-id="${esc(p.id)}">
    <strong>${esc(p.name)}</strong>
    <span class="mono">${p.serviceIds.length} servers</span>
    <button type="button" data-act="preset-run">Resume</button>
    <button type="button" data-act="preset-del" class="danger">Remove</button>
  </div>`).join("");
}

async function openEnv(s) {
  $("#envTitle").textContent = s.name;
  $("#envSaved").textContent = formatEnv(s.env) || "none";
  $("#envLive").textContent = s.rootPid ? "reading…" : "not running";
  openSheet("sheet-env");
  if (!s.rootPid) return;
  try {
    const { env } = await api("GET", `/api/env?pid=${s.rootPid}`);
    $("#envLive").textContent = envBlock(env);
  } catch (e) {
    $("#envLive").textContent = e.message;
  }
}

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
    const ports = w.ports.map((p) => `<a href="http://localhost:${p}" target="_blank" rel="noopener">:${p}</a>`).join(" ");
    return `<article class="wt-card" data-path="${esc(w.path)}">
      <div class="badge">${esc(w.branch || "detached")} · ${w.diskMb} MB</div>
      <div class="name">${esc(name)}</div>
      <div class="path" title="${esc(w.path)}">${esc(home(w.path))}</div>
      <div>${tags} ${ports || '<span class="mono">no servers</span>'}</div>
      <div class="wt-acts">
        <button type="button" data-act="wt-open" data-path="${esc(w.path)}">Open</button>
        <button type="button" data-act="wt-launch" data-path="${esc(w.path)}">Launch</button>
        ${w.main ? "" : `<button type="button" data-act="wt-retire" class="danger" data-path="${esc(w.path)}" data-dirty="${w.dirty ? "1" : ""}" data-locked="${w.locked ? "1" : ""}">Retire</button>`}
      </div>
    </article>`;
  }).join("") : `<p class="empty-note">Scan a folder to see every git checkout inside it.</p>`;
  $("#staleLabel").hidden = wtStale.length === 0;
  $("#wtList").innerHTML = wtStale.map((w) => {
    const act = w.reason === "prunable"
      ? `<button type="button" data-act="wt-prune" data-dir="${esc($("#wt-dir").value)}">Prune</button>`
      : `<button type="button" data-act="wt-remove" class="danger" data-path="${esc(w.path)}">Remove folder</button>`;
    return `<div class="wtrow">
      <div><div class="mono" title="${esc(w.path)}">${esc(home(w.path))}</div><div>${esc(w.detail)}${w.branch ? " · " + esc(w.branch) : ""}</div></div>
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
  const dir = lastWtDir();
  try {
    const data = await api("GET", `/api/attention?dir=${encodeURIComponent(dir)}`);
    alerts = data.alerts ?? [];
    $("#alerts").innerHTML = alerts.length ? alerts.map((a) => `<article class="alert" data-id="${esc(a.serviceId || "")}" data-path="${esc(a.path || "")}">
      <span class="badge kind">${esc(a.kind.replace("-", " "))}</span>
      <div><strong>${esc(a.title)}</strong><p>${esc(a.detail)}</p></div>
      <div class="wt-acts">
        ${a.serviceId ? `<button type="button" data-act="select-alert" data-id="${esc(a.serviceId)}">Logs</button>` : ""}
        ${a.path ? `<button type="button" data-act="wt-open" data-path="${esc(a.path)}">Open</button>` : ""}
      </div>
    </article>`).join("") : `<p class="empty-note">Quiet. No port fights, crashes, dirty review trees, or oversized logs.</p>`;
  } catch (e) {
    $("#alerts").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`;
  }
}

async function fetchLog(id) {
  if (!id) return;
  const s = latest.find((x) => x.id === id);
  if (!s?.hasLog) return;
  try {
    const { lines, levels } = await api("GET", `/api/logs/${encodeURIComponent(id)}?lines=4000`);
    logs[id] = (lines || []).map((text, i) => ({ text, level: levels?.[i] || "other" }));
    if (id === sel) { lastLogSig = ""; paintLog(); }
    else { paintChrome(); paintList(); }
  } catch {}
}

async function refresh() {
  try {
    const data = await api("GET", "/api/services");
    latest = data.services;
    projects = data.projects ?? [];
    presets = data.presets ?? [];
    render();
    if (sel) fetchLog(sel);
  } catch {
    $("#counts").innerHTML = `<span class="err">server unreachable</span>`;
  }
}
const refreshSoon = () => [700, 1600, 3000].forEach((ms) => setTimeout(refresh, ms));

document.addEventListener("click", async (ev) => {
  if (menu && !ev.target.closest(".menu") && !ev.target.closest("#moreBtn") && !ev.target.closest("#logMenuBtn")) closeMenu();
  if (ev.target.closest("a[href]")) return;

  const line = ev.target.closest(".log-line");
  if (line && !ev.target.closest("button")) {
    const s = selected();
    const rec = logText((logs[s?.id] || [])[Number(line.dataset.i)]);
    if (rec) copy(stripAnsi(rec).replace(LOG_TS, "").trim() || stripAnsi(rec));
    return;
  }

  const btn = ev.target.closest("button[data-act], [data-act=select]");
  if (!btn) return;
  const act = btn.dataset.act;
  const holder = btn.closest("[data-id]");
  const id = btn.dataset.id || holder?.dataset.id;
  const s = latest.find((x) => x.id === id) || selected();

  if (act === "select") {
    if (ev.target.closest("button, a")) return;
    select(id);
    return;
  }
  if (act === "close-sheet") { closeSheet(); return; }
  if (act === "start-all") { switchAll(true); return; }
  if (act === "stop-all") { switchAll(false); return; }
  if (act === "sheet-worktrees") {
    openSheet("sheet-worktrees");
    if (!$("#wt-dir").value) $("#wt-dir").value = lastWtDir();
    if (!worktrees.length && !wtStale.length) scanWt();
    return;
  }
  if (act === "sheet-project") { openProjectForm(null); return; }
  if (act === "sheet-preset") { openPresetForm(); return; }
  if (act === "sheet-attention") { openSheet("sheet-attention"); loadAttention(); return; }
  if (act === "copy-cwd" && s) { copy(home(s.cwd) || s.cwd || ""); return; }
  if (act === "copy-cmd" && s) { copy(s.command || ""); return; }
  if (act === "copy-run" && s) { closeMenu(); copy(runCmd(s)); return; }
  if (act === "open-browser" && s) {
    closeMenu();
    const p = portOf(s);
    if (p) window.open(`http://localhost:${p}`, "_blank", "noopener");
    return;
  }
  if (act === "toggle-err-only") { closeMenu(); errOnly = !errOnly; lastLogSig = ""; paintLog(); return; }
  if (act === "toggle-follow") {
    closeMenu();
    follow = !follow;
    if (follow) $("#logBody").scrollTop = $("#logBody").scrollHeight;
    paintLog();
    return;
  }
  if (act === "select-alert" && id) { closeSheet(); select(id); return; }

  if (btn.tagName === "BUTTON") btn.disabled = true;
  try {
    if (act === "toggle" && s) await toggle(s);
    else if ((act === "primary" || act === "restart") && s) {
      if (rowState(s) === "busy") return;
      if (s.status === "running" || act === "restart") await restart(s);
      else await toggle(s);
    }
    else if (act === "pin" && s) { closeMenu(); await api("POST", "/api/pin", { rootPid: s.rootPid }); }
    else if (act === "env" && s) { closeMenu(); await openEnv(s); }
    else if (act === "edit" && s) { closeMenu(); openEdit(s); }
    else if (act === "remove" && s) {
      closeMenu();
      if (!confirm(`Remove saved server ${s.name}?`)) return;
      await api("DELETE", `/api/pin/${encodeURIComponent(s.id)}`);
    }
    else if (act === "hide" && s) {
      closeMenu();
      await api("POST", "/api/ignore", { id: s.id });
    }
    else if (act === "unhide" && s) await api("DELETE", `/api/ignore/${encodeURIComponent(s.id)}`);
    else if (act === "kill-sys") {
      const name = holder?.dataset.name || "this process";
      if (confirm(`Kill ${name}? It is a system process and macOS may restart it.`)) {
        await api("POST", "/api/kill", { rootPid: Number(btn.dataset.root) });
      }
    }
    else if (act === "open-editor" && s) {
      closeMenu();
      if (s.cwd) await api("POST", "/api/open", { path: s.cwd });
    }
    else if (act === "clear-log" && s) {
      closeMenu();
      if (!s.hasLog) return;
      if (!confirm(`Clear the log file for ${s.name}? This truncates ~/.devboard/logs/${s.id}.log.`)) return;
      await api("DELETE", `/api/logs/${encodeURIComponent(s.id)}`);
      logs[s.id] = [];
      lastLogSig = "";
    }
    else if (act === "wt-prune") {
      await api("POST", "/api/worktrees/prune", { dir: btn.dataset.dir || $("#wt-dir").value });
      await scanWt();
    }
    else if (act === "wt-remove") {
      if (!confirm(`Delete ${home(btn.dataset.path)}? It is an orphaned worktree folder, not a git repository.`)) return;
      await api("POST", "/api/worktrees/remove", { path: btn.dataset.path });
      await scanWt();
    }
    else if (act === "wt-open") await api("POST", "/api/open", { path: btn.dataset.path });
    else if (act === "wt-launch") {
      const result = await api("POST", "/api/worktrees/launch", { path: btn.dataset.path });
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
      if ((result.created ?? []).length) {
        toast(`Pinned ${result.created.length} on free ports in that checkout`);
      }
      if (!(result.started ?? []).length && !(result.created ?? []).length) {
        closeSheet();
        if (!addOpen) toggleAdd();
        $("#a-cwd").value = btn.dataset.path;
        $("#a-port").value = result.port;
        loadSuggest(btn.dataset.path, "#a-suggest", "#a-cmd", "#a-port");
        toast("No pinned servers in that checkout — add one on a free port.");
      }
    }
    else if (act === "wt-retire") {
      const forceNeeded = btn.dataset.dirty === "1" || btn.dataset.locked === "1";
      if (!confirm(forceNeeded
        ? `Retire ${home(btn.dataset.path)}? It is dirty or locked. This force-removes the checkout.`
        : `Retire ${home(btn.dataset.path)}? The branch stays in the repo.`)) return;
      try {
        await api("POST", "/api/worktrees/retire", { path: btn.dataset.path, force: forceNeeded });
      } catch (e) {
        if (!forceNeeded && /uncommitted|locked/i.test(e.message) && confirm(`${e.message}. Force retire?`)) {
          await api("POST", "/api/worktrees/retire", { path: btn.dataset.path, force: true });
        } else throw e;
      }
      await scanWt();
    }
    else if (act === "group" && s) {
      closeMenu();
      await api("POST", `/api/projects/${encodeURIComponent(btn.dataset.project)}/members`, { id: s.id });
    }
    else if (act === "ungroup" && s) {
      closeMenu();
      const projectId = btn.dataset.project;
      if (projectId) await api("DELETE", `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(s.id)}`);
    }
    else if (act === "project-start") {
      const projectId = id;
      for (const mid of (projects.find((p) => p.id === projectId)?.memberIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "stopped") { setBusy(mid, "starting"); appendStartLines(m); }
      }
      lastLogSig = "";
      render();
      const result = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/start`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
    }
    else if (act === "project-stop") {
      if (!confirm(`Stop every running server in ${btn.dataset.name || holder?.dataset.name}?`)) return;
      const projectId = id;
      for (const mid of (projects.find((p) => p.id === projectId)?.memberIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "running") setBusy(mid, "stopping");
      }
      render();
      const result = await api("POST", `/api/projects/${encodeURIComponent(projectId)}/stop`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
    }
    else if (act === "project-folder") {
      await api("POST", `/api/projects/${encodeURIComponent(holder.dataset.id)}/members`, { folder: holder.dataset.folder });
      paintProjectList();
    }
    else if (act === "project-edit") {
      openProjectForm(projects.find((p) => p.id === (btn.dataset.id || holder?.dataset.id)));
    }
    else if (act === "project-delete") {
      if (!confirm(`Remove project ${holder.dataset.name}? The servers stay on the board.`)) return;
      await api("DELETE", `/api/projects/${encodeURIComponent(holder.dataset.id)}`);
    }
    else if (act === "preset-run") {
      const result = await api("POST", `/api/presets/${encodeURIComponent(id)}/resume`);
      for (const err of result.errors ?? []) toast(`${err.id}: ${err.error}`);
      for (const mid of (presets.find((p) => p.id === id)?.serviceIds ?? [])) {
        const m = latest.find((x) => x.id === mid);
        if (m?.status === "stopped") { setBusy(mid, "starting"); appendStartLines(m); }
      }
      lastLogSig = "";
      for (const url of result.urls ?? []) {
        try { window.open(url, "_blank", "noopener"); } catch {}
      }
    }
    else if (act === "preset-del") {
      if (!confirm(`Remove preset ${holder?.dataset.id}?`)) return;
      await api("DELETE", `/api/presets/${encodeURIComponent(id)}`);
    }
  } catch (e) {
    if (id) clearBusy(id);
    toast(e.message);
  } finally {
    if (btn.tagName === "BUTTON") btn.disabled = false;
    render();
    refresh();
    if (["toggle", "restart", "primary", "project-start", "project-stop", "preset-run", "wt-launch"].includes(act)) refreshSoon();
  }
});

$("#moreBtn").onclick = (ev) => setMenu("top", ev);
$("#addBtn").onclick = () => { closeMenu(); toggleAdd(); };
$("#addCancel").onclick = () => { addOpen = false; $("#addForm").hidden = true; };
$("#q").oninput = (ev) => { query = ev.target.value; paintList(); };
$("#logFilter").oninput = (ev) => { logFilter = ev.target.value; lastLogSig = ""; paintLog(); };
$("#errChip").onclick = (ev) => {
  if (ev.shiftKey) { errOnly = !errOnly; lastLogSig = ""; paintLog(); }
  else nextErr();
};
$("#followBtn").onclick = () => {
  follow = true;
  $("#logBody").scrollTop = $("#logBody").scrollHeight;
  paintLog();
};
$("#logBody").addEventListener("scroll", () => {
  const b = $("#logBody");
  const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
  if (!atBottom && follow) { follow = false; paintLogTools(selected()); }
  else if (atBottom && !follow) { follow = true; paintLogTools(selected()); }
});
$("#overlay").addEventListener("click", (ev) => { if (ev.target === $("#overlay")) closeSheet(); });

$("#a-cwd").addEventListener("blur", () => loadSuggest($("#a-cwd").value, "#a-suggest", "#a-cmd", "#a-port"));
$("#f-cwd").addEventListener("blur", () => loadSuggest($("#f-cwd").value, "#f-suggest", "#f-cmd", "#f-port"));
function bindSuggest(box) {
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".suggest");
    if (!btn) return;
    const cmd = $(box.dataset.cmd);
    const port = $(box.dataset.port);
    if (cmd) cmd.value = btn.dataset.cmd || "";
    if (port && btn.dataset.port) port.value = btn.dataset.port;
  });
}
bindSuggest($("#a-suggest"));
bindSuggest($("#f-suggest"));

$("#addForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  try {
    await api("POST", "/api/pinned", { name: data.name, cwd: data.cwd, command: data.command, port: Number(data.port) });
    addOpen = false;
    f.hidden = true;
    f.reset();
    refresh();
  } catch (e) { $("#addError").textContent = e.message; }
};
$("#editForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  const body = { name: data.name, cwd: data.cwd, command: data.command, port: Number(data.port), healthUrl: data.healthUrl, envText: data.envText, restartOnCrash: f.elements.restartOnCrash.checked };
  try {
    await api("PUT", `/api/pinned/${encodeURIComponent(editingId)}`, body);
    closeSheet();
    refresh();
  } catch (e) { $("#formError").textContent = e.message; }
};
$("#projectForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = Object.fromEntries(new FormData(f));
  const body = { name: data.name, folder: data.folder, links: data.links, addFromFolder: f.elements.addFromFolder.checked };
  try {
    if (editingProjectId) await api("PUT", `/api/projects/${encodeURIComponent(editingProjectId)}`, body);
    else await api("POST", "/api/projects", body);
    closeSheet();
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
    f.reset();
    await refresh();
    openPresetForm();
  } catch (e) { $("#presetError").textContent = e.message; }
};
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

document.addEventListener("keydown", (ev) => {
  const typing = ev.target.closest?.("input, textarea");
  if (ev.key === "Escape") {
    if (typing) { ev.target.blur(); return; }
    if (menu) { closeMenu(); return; }
    if (overlayOpen()) { closeSheet(); return; }
    if (addOpen) { addOpen = false; $("#addForm").hidden = true; }
    return;
  }
  if (typing) return;
  if (ev.key === "/") { ev.preventDefault(); $("#q").focus(); return; }
  if (overlayOpen()) return;
  if (ev.key === "ArrowDown" || ev.key === "j") { ev.preventDefault(); moveSel(1); }
  else if (ev.key === "ArrowUp" || ev.key === "k") { ev.preventDefault(); moveSel(-1); }
  else if (ev.key === " ") { ev.preventDefault(); const s = selected(); if (s) toggle(s); }
  else if (ev.key === "r") { const s = selected(); if (s?.status === "running") restart(s); }
  else if (ev.key === "e") { ev.preventDefault(); nextErr(); }
  else if (ev.key === "c" && !ev.metaKey && !ev.ctrlKey) { const s = selected(); if (s) copy(runCmd(s)); }
  else if (ev.key === "o" && !ev.metaKey && !ev.ctrlKey) {
    const s = selected();
    const p = s && portOf(s);
    if (p) window.open(`http://localhost:${p}`, "_blank", "noopener");
  }
});

paintClock();
paintChrome();
refresh();
setInterval(paintClock, 1000);
setInterval(refresh, 3000);
setInterval(() => { if (sel) fetchLog(sel); }, 2000);
