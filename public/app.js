import {
  contentParts, ctxTokens, entryBody, entryTid, errorIndexes, formatLogTime, httpSpans, idSpans,
  levelBadge, lineKind, matchesEntry, mergeSpans, prettyCtx, visibleEntries, visibleGroups,
} from "./log-view.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const home = (p) => (p ? p.replace(/^\/Users\/[^/]+/, "~") : "");
const nowClock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

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
let restartAfterSave = null;
let editingPresetId = null;
let clock = nowClock();
let toastTimer = 0;
let logDirty = true;
let logRendered = null;
let newSinceFollow = 0;
let trace = null;
let jumpLine = null;
/** Absolute line keys (`base + i`) whose JSON context is toggled away from the pane default. */
const ctxOpen = new Set();
/** ⌥click on any chevron flips the default for every line, so one click opens the pane. */
let ctxAll = false;
/** Absolute line keys of the groups whose folded tail is open. */
const tailOpen = new Set();
/** Groups the pane opened by itself (the newest crash), so closing one keeps it closed. */
const autoOpened = new Set();
let autoOpenKey = null;

try { sel = localStorage.getItem("devboard.sel"); } catch {}
try {
  const q = new URLSearchParams(location.search).get("sel");
  if (q) saveSel(q);
} catch {}

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
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastAction = null;
function toast(msg, copied = false) {
  toastAction = null;
  toastText = msg ? { text: String(msg), copied } : "";
  paintToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText = ""; toastAction = null; paintToast(); }, 1600);
}
function toastBusyWorktree(names, rootPids, path, force, remove) {
  toastAction = { rootPids, path, force, remove };
  toastText = { text: `Stop and retire · ${names.join(", ")}`, copied: false };
  paintToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText = ""; toastAction = null; paintToast(); }, 8000);
}
function copy(text) {
  const t = String(text ?? "");
  navigator.clipboard.writeText(t).then(() => toast(t, true)).catch(() => toast("could not copy"));
}
function paintToast() {
  const el = $("#toast");
  el.hidden = !toastText;
  if (!toastText) { el.textContent = ""; return; }
  const label = toastText.copied
    ? `copied · <span class="d">${esc(toastText.text)}</span>`
    : esc(toastText.text);
  el.innerHTML = toastAction
    ? `<span class="toast-msg">${label}</span><button type="button" data-act="stop-retire">${toastAction.remove ? "Stop and remove" : "Stop and retire"}</button>`
    : label;
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
  editingPresetId = null;
  restartAfterSave = null;
  const note = $("#f-lossy-note");
  if (note) note.hidden = true;
}
function openSheet(id) {
  closeMenu();
  hideSheets();
  $("#overlay").hidden = false;
  $(`#${id}`).hidden = false;
}

function spanHtml(span, inner) {
  if (span.kind === "id") return `<button type="button" class="log-id" data-token="${esc(span.value)}">${inner}</button>`;
  if (span.kind === "http") return `<span class="${esc(span.cls)}">${inner}</span>`;
  return inner;
}

/**
 * One line's text with the pieces the page can act on marked up: id tokens (F-29) and the
 * method, path, status, and duration of a request line. Spans never overlap; ids win.
 */
function richText(text, entry) {
  const spans = mergeSpans([...idSpans(text, entry?.ids), ...httpSpans(text, entry?.http)]);
  let html = "";
  let cur = 0;
  for (const s of spans) {
    html += esc(text.slice(cur, s.start));
    html += spanHtml(s, esc(text.slice(s.start, s.end)));
    cur = s.end;
  }
  return html + esc(text.slice(cur));
}

function defaultTraceIds() {
  const s = selected();
  if (s?.id) {
    const p = projects.find((x) => x.memberIds.includes(s.id));
    if (p?.memberIds.length) return [...p.memberIds];
  }
  return latest.filter((x) => x.kind === "dev" && x.status === "running" && !x.hidden && x.id).map((x) => x.id);
}

function closeTrace() {
  if (!trace) return;
  trace = null;
  markLogDirty();
  paintLog();
}

async function openTrace(token) {
  if (!token) return;
  setFollow(false);
  trace = { token, groups: [], loading: true };
  markLogDirty();
  paintLog();
  const ids = defaultTraceIds();
  if (!ids.length && selected()?.id) ids.push(selected().id);
  if (!ids.length) {
    trace = { token, groups: [], loading: false, error: "no services to search" };
    markLogDirty();
    paintLog();
    return;
  }
  try {
    const q = new URLSearchParams({ token, ids: ids.join(",") });
    const data = await api("GET", `/api/trace?${q}`);
    trace = { token, groups: data.groups || [], loading: false };
  } catch (e) {
    trace = { token, groups: [], loading: false, error: e.message };
  }
  markLogDirty();
  paintLog();
}

async function jumpToHit(id, i) {
  trace = null;
  setFollow(false);
  jumpLine = i;
  if (sel !== id) {
    saveSel(id);
    errCursor = null;
    markLogDirty();
    paintList();
  } else {
    markLogDirty();
  }
  await fetchLog(id, { full: true, lines: 5000 });
  markLogDirty();
  paintLog();
  revealKey(i);
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
  const buf = logs[s.id] ?? (logs[s.id] = { entries: [], next: null, base: 0 });
  const added = optimisticStartLines(s).map((text, k) => ({ i: buf.entries.length + k, text, level: "other" }));
  buf.entries.push(...added);
  buf.next = null; // the next poll reloads, so the real start marker replaces these two
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

/** The buffer for one log: entries, the byte cursor, and how many lines were dropped off the front. */
function logBuf(id) {
  return (id && logs[id]) || null;
}
function entriesOf(id) {
  return logBuf(id)?.entries ?? [];
}
function baseOf(id) {
  return logBuf(id)?.base ?? 0;
}
function markLogDirty() { logDirty = true; }
function setFollow(on) {
  if (follow === on) return;
  follow = on;
  newSinceFollow = 0;
}

/** What `visibleEntries`, `matchesEntry`, and the level chips read. */
function viewState() {
  return { filter: logFilter, errOnly };
}
function shownEntries(s) {
  return visibleEntries(entriesOf(s?.id), viewState());
}

function shownGroups(s) {
  return visibleGroups(entriesOf(s?.id), viewState());
}

/** Put text in the log filter and apply it. Clicking a logger name is how you filter to one. */
function searchFor(text) {
  const field = $("#logFilter");
  field.value = text;
  logFilter = text;
  markLogDirty();
  paintLog();
}

function paintLogTools(s) {
  const raw = entriesOf(s?.id);
  const errIdx = errorIndexes(raw, baseOf(s?.id));
  const shown = shownEntries(s);
  const chip = $("#errChip");
  const followBtn = $("#followBtn");
  const tracing = !!trace;
  $("#logFilter").hidden = tracing;
  $("#traceClose").hidden = !tracing;
  if (tracing) {
    chip.hidden = true;
    followBtn.hidden = true;
    const n = (trace.groups || []).reduce((sum, g) => sum + g.hits.length, 0);
    $("#logCount").textContent = trace.loading ? "tracing…" : `${n} hit${n === 1 ? "" : "s"}`;
    $("#logCount").title = trace.token;
    return;
  }
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
  followBtn.hidden = follow;
  followBtn.textContent = newSinceFollow ? `↓ ${newSinceFollow} new` : (followBtn.dataset.label || "↓ Resume follow");
  const filtered = !!(logFilter.trim() || errOnly);
  $("#logCount").textContent = s ? (filtered ? `${shown.length}/${raw.length} lines` : `${raw.length} lines`) : "";
  $("#logCount").title = s ? `~/.devboard/logs/${s.id}.log` : "";
}

function paintTraceBody() {
  const body = $("#logBody");
  if (trace.loading) {
    body.innerHTML = `<div class="empty"><span>Tracing ${esc(trace.token)}…</span></div>`;
    return;
  }
  if (trace.error) {
    body.innerHTML = `<div class="empty"><span>${esc(trace.error)}</span></div>`;
    return;
  }
  const groups = trace.groups || [];
  if (!groups.length) {
    body.innerHTML = `<div class="empty"><span>No hits for ${esc(trace.token)} in the current logs. Services have to print the same id; there is no time-window fallback.</span></div>`;
    return;
  }
  const nameOf = (id) => latest.find((x) => x.id === id)?.name || id;
  const chips = groups.map((g) =>
    `<button type="button" class="trace-chip" data-act="trace-jump" data-id="${esc(g.id)}" data-i="${g.hits[0].i}">${esc(nameOf(g.id))} · ${g.hits.length}</button>`
  ).join("");
  const blocks = groups.map((g) => {
    const hits = g.hits.map((h) => {
      const t = formatLogTime(h.time);
      return `<div class="log-line ${lineKind(h)}" data-act="trace-jump" data-id="${esc(g.id)}" data-i="${h.i}" title="Open this log at this line">
      <span class="ln">${h.i + 1}</span>
      ${t ? `<span class="t">${esc(t)}</span>` : ""}
      <span class="lvl">${levelBadge(h.level)}</span>
      <span class="c">${richText(contentParts(h).text, h)}</span>
    </div>`;
    }).join("");
    return `<div class="trace-group"><div class="trace-svc">${esc(nameOf(g.id))}</div>${hits}</div>`;
  }).join("");
  body.innerHTML = `<div class="trace"><div class="trace-head"><span class="trace-tok">${esc(trace.token)}</span>${chips}</div>${blocks}</div>`;
}

/** A log has a time column when any entry in the buffer printed one. */
function showTimeFor(id) {
  return entriesOf(id).some((e) => formatLogTime(e.time));
}

function caretHtml(s) {
  return rowState(s) === "on" ? `<div class="caret"><span style="width:30px"></span><i></i></div>` : "";
}

/** Is this line's JSON context open? `ctxAll` flips the default, so ⌥click opens the whole pane. */
function ctxIsOpen(key) {
  return ctxAll !== ctxOpen.has(key);
}

function ctxBlock(e, key) {
  if (!e.ctx || !ctxIsOpen(key)) return "";
  const tokens = ctxTokens(prettyCtx(e.ctx))
    .map((t) => (t.kind ? `<span class="j-${esc(t.kind)}">${esc(t.text)}</span>` : esc(t.text)))
    .join("");
  return `<pre class="ctx">${tokens}</pre>`;
}

function entryByKey(id, key) {
  return entriesOf(id)[key - baseOf(id)] ?? null;
}

/** Open or close one line's context in place, so the reading position survives the click. */
function syncCtxNode(node) {
  const btn = node.querySelector(".ctx-btn");
  if (!btn) return;
  const key = Number(btn.dataset.key);
  const entry = entryByKey(selected()?.id, key);
  if (!entry) return;
  const open = ctxIsOpen(key);
  btn.classList.toggle("on", open);
  const pre = node.querySelector("pre.ctx");
  if (open && !pre) node.insertAdjacentHTML("beforeend", ctxBlock(entry, key));
  else if (!open && pre) pre.remove();
}

function toggleCtx(key, all) {
  if (all) {
    ctxAll = !ctxAll;
    ctxOpen.clear();
  } else if (ctxOpen.has(key)) ctxOpen.delete(key);
  else ctxOpen.add(key);
  const body = $("#logBody");
  const nodes = all ? [...body.querySelectorAll(".log-line")] : [document.getElementById(`log-${selected()?.id}-${key}`)];
  for (const node of nodes) if (node) syncCtxNode(node);
}

/** Logger, message, and the chevron that folds the trailing JSON. The badge already carries the level. */
function contentHtml(e, key) {
  const { logger, text, ctx } = contentParts(e);
  const lg = logger
    ? `<button type="button" class="lg" data-act="logger" data-logger="${esc(logger)}" title="Search this logger">${esc(logger)}</button>`
    : "";
  const chevron = ctx
    ? `<button type="button" class="ctx-btn${ctxIsOpen(key) ? " on" : ""}" data-act="ctx" data-key="${key}" title="JSON context · ⌥click toggles every line">{…}</button>`
    : "";
  return `${lg}${richText(text, e)}${chevron}`;
}

function logLineHtml(s, e, showTime, opts = {}) {
  const t = formatLogTime(e.time);
  const tid = entryTid(e);
  const key = baseOf(s.id) + e.i;
  const cls = opts.cont
    ? "log-line cont"
    : `log-line ${lineKind(e)}${errCursor === key || jumpLine === key ? " cur" : ""}`;
  return `<div class="${cls}" data-i="${key}" title="Click to copy">
      <span class="ln">${key + 1}</span>
      ${opts.repeat > 1 ? `<span class="rep" title="the same line ${opts.repeat} times">×${opts.repeat}</span>` : ""}
      ${showTime ? `<span class="t">${esc(t)}</span>` : ""}
      <span class="lvl">${opts.cont ? "" : levelBadge(e.level)}</span>
      ${tid ? `<span class="log-tid" title="request id">${esc(tid)}</span>` : ""}
      <span class="c">${contentHtml(e, key)}${opts.fold ?? ""}</span>
      ${ctxBlock(e, key)}
    </div>`;
}

/** Is this group's folded tail open? The newest crash opens itself once; the Set holds the rest. */
function tailIsOpen(key) {
  return tailOpen.has(key);
}

/** One group: the head line, its `▶ +N lines` chevron, and the tail when it is open. */
function groupHtml(s, g, showTime) {
  const key = baseOf(s.id) + g.head.i;
  const open = tailIsOpen(key);
  const fold = g.tail.length
    ? `<button type="button" class="fold" data-act="fold" data-key="${key}">${open ? "▼" : "▶"} +${g.tail.length} lines</button>`
    : "";
  const head = logLineHtml(s, g.head, showTime, { repeat: g.repeat, fold });
  const tail = g.tail.length && open ? tailHtml(s, g, showTime) : "";
  return `<div class="log-group" data-i="${key}" id="log-${esc(s.id)}-${key}">${head}${tail}</div>`;
}

function tailHtml(s, g, showTime) {
  return `<div class="log-tail">${g.tail.map((e) => logLineHtml(s, e, showTime, { cont: true })).join("")}</div>`;
}

/**
 * The newest error group with frames under it opens itself; when a newer one arrives the
 * older one closes again, so exactly one crash is open unless you opened others by hand.
 */
function autoOpenNewestCrash(groups, base) {
  let key = null;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.head.level === "error" && g.tail.length) { key = base + g.head.i; break; }
  }
  if (key === autoOpenKey) return;
  if (autoOpenKey != null && autoOpened.has(autoOpenKey)) {
    autoOpened.delete(autoOpenKey);
    setFold(autoOpenKey, false);
  }
  autoOpenKey = key;
  if (key != null && !autoOpened.has(key)) {
    autoOpened.add(key);
    setFold(key, true);
  }
}

/** The group a line belongs to: walk back over the frames to the line that carries them. */
function groupKeyFor(key) {
  const base = baseOf(sel);
  let k = key;
  while (k > base && entryByKey(sel, k)?.cont) k--;
  return k;
}

function groupOf(key) {
  const entries = entriesOf(sel);
  const at = key - baseOf(sel);
  const head = entries[at];
  if (!head) return null;
  const tail = [];
  for (let k = at + 1; k < entries.length && entries[k].cont; k++) tail.push(entries[k]);
  return { head, tail };
}

/** Open or close one tail in place, so the reading position survives the click. */
function setFold(key, open) {
  if (open) tailOpen.add(key);
  else tailOpen.delete(key);
  const s = selected();
  const node = s ? document.getElementById(`log-${s.id}-${key}`) : null;
  if (!node) return; // not rendered yet; the next render reads the Set
  const existing = node.querySelector(".log-tail");
  const g = groupOf(key);
  if (open && !existing && g) node.insertAdjacentHTML("beforeend", tailHtml(s, g, showTimeFor(s.id)));
  else if (!open && existing) existing.remove();
  const btn = node.querySelector("button.fold");
  if (btn && g) btn.textContent = `${open ? "▼" : "▶"} +${g.tail.length} lines`;
}

function toggleFold(key) {
  setFold(key, !tailIsOpen(key));
}

/** Bring a line into view, opening the group that holds it when it is folded away. */
function revealKey(key) {
  const s = selected();
  if (!s) return;
  const head = groupKeyFor(key);
  if (head !== key && !tailIsOpen(head)) toggleFold(head);
  const c = $("#logBody");
  const el = document.getElementById(`log-${s.id}-${head}`);
  if (c && el) c.scrollTop = el.offsetTop - c.offsetTop - Math.min(80, c.clientHeight / 3);
}

/** Full repaint. Runs only when view state changes: selection, filter, level, follow, status. */
function rebuildBody(s) {
  const body = $("#logBody");
  if (trace) {
    paintTraceBody();
    logRendered = { id: s?.id ?? null, mode: "trace" };
    return;
  }
  if (!s) {
    body.innerHTML = `<div class="empty">Select a server to read its output.</div>`;
    logRendered = { id: null, mode: "empty" };
    return;
  }
  const raw = entriesOf(s.id);
  const shown = shownEntries(s);
  const unmanaged = s.status === "running" && !s.hasLog && !raw.length;
  const filteredEmpty = raw.length && !shown.length;

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
      body.innerHTML = caretHtml(s);
      logRendered = { id: s.id, mode: "caret" };
      if (follow) body.scrollTop = body.scrollHeight;
      return;
    }
    body.innerHTML = `<div class="empty"><span>${esc(text)}</span>${startBtn}</div>`;
    logRendered = { id: s.id, mode: "empty" };
    return;
  }

  const showTime = showTimeFor(s.id);
  const base = baseOf(s.id);
  const groups = shownGroups(s);
  autoOpenNewestCrash(groups, base);
  body.innerHTML = groups.map((g) => groupHtml(s, g, showTime)).join("") + caretHtml(s);
  logRendered = { id: s.id, mode: "lines", showTime, lastKey: base + groups[groups.length - 1].head.i };
  if (follow) body.scrollTop = body.scrollHeight;
}

/**
 * Append path: re-render the last group (a frame or a repeat may have joined it) and add
 * the groups after it. No rebuild, so 10 000 lines are not re-created every second.
 */
function syncGroups(s, body, showTime, added) {
  const groups = shownGroups(s);
  if (!groups.length) return false;
  const base = baseOf(s.id);
  const lastKey = logRendered.lastKey;
  let from = 0;
  if (lastKey != null) {
    const node = document.getElementById(`log-${s.id}-${lastKey}`);
    if (!node) return false;
    from = groups.findIndex((g) => base + g.end >= lastKey);
    if (from < 0) return false;
    node.remove();
  }
  autoOpenNewestCrash(groups, base);
  const html = groups.slice(from).map((g) => groupHtml(s, g, showTime)).join("");
  const caret = body.querySelector(".caret");
  if (caret) caret.insertAdjacentHTML("beforebegin", html);
  else body.insertAdjacentHTML("beforeend", html);
  logRendered.lastKey = base + groups[groups.length - 1].head.i;
  if (!follow) newSinceFollow += added.filter((e) => matchesEntry(e, viewState())).length;
  return true;
}

function appendToLog(s, added, base) {
  const body = $("#logBody");
  const showTime = showTimeFor(s.id);
  if (trace || logDirty || logRendered?.id !== s.id || logRendered.mode !== "lines" || logRendered.showTime !== showTime) {
    markLogDirty();
    paintLogBody(s);
    return;
  }
  if (!syncGroups(s, body, showTime, added)) {
    markLogDirty();
    paintLogBody(s);
    return;
  }
  if (base) dropLeadingLines(body, base);
  const caret = body.querySelector(".caret");
  if (rowState(s) === "on" && !caret) body.insertAdjacentHTML("beforeend", caretHtml(s));
  else if (rowState(s) !== "on" && caret) caret.remove();
  if (follow) body.scrollTop = body.scrollHeight;
}

function paintLogBody(s) {
  if (!logDirty) {
    if (follow) { const b = $("#logBody"); b.scrollTop = b.scrollHeight; }
    return;
  }
  logDirty = false;
  rebuildBody(s);
}

let logStateSig = "";
function paintLog() {
  const s = selected();
  const sig = s ? [s.id, s.status, rowState(s), s.hasLog, !!trace, trace?.loading, (trace?.groups ?? []).length].join("|") : "none";
  if (sig !== logStateSig) {
    logStateSig = sig;
    markLogDirty();
  }
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
  jumpLine = null;
  // Line keys belong to one log, so the folds and open contexts of the old one go.
  ctxOpen.clear();
  ctxAll = false;
  tailOpen.clear();
  autoOpened.clear();
  autoOpenKey = null;
  if (trace) { trace = null; }
  markLogDirty();
  paintList();
  paintLog();
  if (follow) $("#logBody").scrollTop = $("#logBody").scrollHeight;
  fetchLog(id);
}

function nextErr() {
  const s = selected();
  if (!s) return;
  const idx = errorIndexes(entriesOf(s.id), baseOf(s.id));
  if (!idx.length) return;
  const cur = errCursor == null ? -1 : errCursor;
  const next = idx.find((i) => i > cur) ?? idx[0];
  errCursor = next;
  setFollow(false);
  markLogDirty();
  paintLog();
  revealKey(next);
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
      markLogDirty();
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
  markLogDirty();
  render();
  try {
    await api("POST", "/api/restart", s.rootPid ? { rootPid: s.rootPid } : { id: s.id });
  } catch (e) {
    clearBusy(s.id);
    if (e.status === 409 && /confirmation/i.test(e.message)) {
      restartAfterSave = s;
      await openEdit(s, { lossy: true });
      return;
    }
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
  markLogDirty();
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
    $("#a-import").hidden = true;
    $("#addError").textContent = "";
    $("#a-name").focus();
  }
}

async function openEdit(s, opts = {}) {
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
  $("#f-lossy-note").hidden = !opts.lossy;
  $("#formError").textContent = opts.lossy ? "Check quoting before this restart runs." : "";
  loadSuggest(s.cwd, "#f-suggest", "#f-cmd", "#f-port");
  openSheet("sheet-edit");
  if (s.pinned && s.id) {
    try {
      const { pinned } = await api("GET", `/api/pinned/${encodeURIComponent(s.id)}`);
      f.elements.envText.value = formatEnv(pinned.env);
    } catch {}
  }
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

function openPresetForm(p) {
  const f = $("#presetForm");
  f.reset();
  const selected = new Set(p?.serviceIds ?? []);
  const dev = latest.filter((s) => s.kind === "dev" && !s.hidden && s.id);
  $("#pr-services").innerHTML = dev.length
    ? dev.map((s) => `<label class="check"><input type="checkbox" name="serviceId" value="${esc(s.id)}" ${p ? selected.has(s.id) : s.status === "running" ? "checked" : ""}> ${esc(s.name)} <span class="mono">:${s.ports[0] ?? "—"}</span></label>`).join("")
    : `<p class="empty-note">Pin a server first, then save it here.</p>`;
  if (p) {
    f.elements.name.value = p.name;
    f.elements.urls.value = (p.urls ?? []).join("\n");
    f.elements.worktree.value = p.worktree ?? "";
    f.elements.openEditor.checked = !!p.openEditor;
    $("#presetFormTitle").textContent = `Edit ${p.name}`;
    $("#presetSubmit").textContent = "Save changes";
  } else {
    f.elements.urls.value = dev.filter((s) => s.status === "running" && s.ports[0]).map((s) => `http://127.0.0.1:${s.ports[0]}`).join("\n");
    $("#presetFormTitle").textContent = "Save a preset";
    $("#presetSubmit").textContent = "Save preset";
  }
  $("#presetError").textContent = "";
  paintPresets();
  openSheet("sheet-preset");
  editingPresetId = p ? p.id : null;
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
    <button type="button" data-act="preset-edit">Edit</button>
    <button type="button" data-act="preset-del" class="danger">Remove</button>
  </div>`).join("");
}

let envPid = null;
async function loadLiveEnv(pid, reveal) {
  const q = reveal ? "&reveal=1" : "";
  const { env } = await api("GET", `/api/env?pid=${pid}${q}`);
  $("#envLive").textContent = envBlock(env);
}

async function openEnv(s) {
  envPid = s.rootPid || null;
  $("#envTitle").textContent = s.name;
  $("#envSaved").textContent = formatEnv(s.env) || "none";
  $("#envLive").textContent = envPid ? "reading…" : "not running";
  $("#envReveal").hidden = !envPid;
  openSheet("sheet-env");
  if (!envPid) return;
  try {
    await loadLiveEnv(envPid, false);
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
      <div class="badge">${esc(w.branch || "detached")} · ${w.diskMb == null ? "…" : `${w.diskMb} MB`}</div>
      <div class="name">${esc(name)}</div>
      <div class="path" title="${esc(w.path)}">${esc(home(w.path))}</div>
      <div>${tags} ${ports || '<span class="mono">no servers</span>'}</div>
      <div class="wt-acts">
        <button type="button" data-act="wt-open" data-path="${esc(w.path)}">Open</button>
        <button type="button" data-act="wt-launch" data-path="${esc(w.path)}">Launch</button>
        ${w.hasTemplate ? `<button type="button" data-act="wt-import" data-path="${esc(w.path)}">Import pins</button>` : ""}
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

const LOG_WINDOW = 4000;      // lines on a full load
const LOG_MAX_ENTRIES = 10000; // buffer cap; older entries drop off the front and `base` rises

/** Drop the oldest entries past the cap, raise `base`, and renumber. Returns how many went. */
function trimBuffer(buf) {
  const over = buf.entries.length - LOG_MAX_ENTRIES;
  if (over <= 0) return 0;
  buf.entries.splice(0, over);
  buf.base += over;
  for (let k = 0; k < buf.entries.length; k++) buf.entries[k].i = k;
  return over;
}

/** Drop the rendered groups that fell out of the buffer, keeping the reading position. */
function dropLeadingLines(body, base) {
  const top = body.scrollTop;
  const height = body.scrollHeight;
  let node = body.firstElementChild;
  while (node && node.classList.contains("log-group") && Number(node.dataset.i) < base) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  const removed = height - body.scrollHeight;
  // Absolute, not relative: the browser may have anchored the scroll itself, and
  // subtracting the removed height a second time would slide the view backwards.
  if (removed > 0 && !follow) body.scrollTop = Math.max(0, top - removed);
}

/**
 * One poll of the selected log. Full window on first load, after a reset, or when asked;
 * otherwise `?from=<byte cursor>`, which is a few hundred bytes while the process is idle.
 */
async function fetchLog(id, opts = {}) {
  if (!id) return;
  const s = latest.find((x) => x.id === id);
  if (!s?.hasLog) return;
  const buf = logBuf(id);
  const full = opts.full || !buf || buf.next == null;
  try {
    const q = full ? `lines=${opts.lines ?? LOG_WINDOW}` : `from=${buf.next}`;
    const data = await api("GET", `/api/logs/${encodeURIComponent(id)}?${q}`);
    if (!full && data.reset) {
      await fetchLog(id, { full: true });
      return;
    }
    const incoming = data.entries || [];
    if (full) {
      logs[id] = { entries: incoming.map((e, k) => ({ ...e, i: k })), next: data.next ?? data.size ?? 0, base: 0 };
      if (id !== sel) { paintChrome(); paintList(); return; }
      markLogDirty();
      paintLog();
      return;
    }
    const cur = logBuf(id);
    cur.next = data.next ?? cur.next;
    if (!incoming.length) return;
    const added = incoming.map((e, k) => ({ ...e, i: cur.entries.length + k }));
    cur.entries.push(...added);
    trimBuffer(cur);
    if (id !== sel) { paintChrome(); paintList(); return; }
    if (trace) return;
    appendToLog(s, added, cur.base);
    paintLogTools(s);
  } catch {}
}

async function refresh() {
  try {
    const data = await api("GET", "/api/services");
    latest = data.services;
    projects = data.projects ?? [];
    presets = data.presets ?? [];
    render();
  } catch {
    $("#counts").innerHTML = `<span class="err">server unreachable</span>`;
  }
}
const refreshSoon = () => [700, 1600, 3000].forEach((ms) => setTimeout(refresh, ms));

document.addEventListener("click", async (ev) => {
  if (menu && !ev.target.closest(".menu") && !ev.target.closest("#moreBtn") && !ev.target.closest("#logMenuBtn")) closeMenu();
  if (ev.target.closest("a[href]")) return;

  const idBtn = ev.target.closest(".log-id");
  if (idBtn?.dataset.token) { openTrace(idBtn.dataset.token); return; }

  const foldBtn = ev.target.closest("button[data-act=fold]");
  if (foldBtn) { toggleFold(Number(foldBtn.dataset.key)); return; }

  const ctxBtn = ev.target.closest("button[data-act=ctx]");
  if (ctxBtn) { toggleCtx(Number(ctxBtn.dataset.key), ev.altKey); return; }

  const lgBtn = ev.target.closest("button[data-act=logger]");
  if (lgBtn) { searchFor(lgBtn.dataset.logger || ""); return; }

  const line = ev.target.closest(".log-line");
  if (line && !ev.target.closest("button") && line.dataset.act !== "trace-jump") {
    const s = selected();
    const key = Number(line.dataset.i);
    const rec = entryByKey(s?.id, key);
    if (!rec) return;
    // A head copies the whole dump; a frame copies the frame.
    const head = line.closest(".log-group");
    const g = head && Number(head.dataset.i) === key ? groupOf(key) : null;
    copy(g?.tail.length ? [g.head, ...g.tail].map((x) => x.text).join("\n") : entryBody(rec) || rec.text);
    return;
  }

  const btn = ev.target.closest("button[data-act], [data-act=select], [data-act=trace-jump]");
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
  if (act === "close-trace") { closeTrace(); return; }
  if (act === "trace-jump") {
    const i = Number(btn.dataset.i);
    if (id && Number.isInteger(i) && i >= 0) jumpToHit(id, i);
    return;
  }
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
  if (act === "toggle-err-only") { closeMenu(); errOnly = !errOnly; markLogDirty(); paintLog(); return; }
  if (act === "toggle-follow") {
    closeMenu();
    setFollow(!follow);
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
    else if (act === "env-reveal") {
      if (!envPid) return;
      try { await loadLiveEnv(envPid, true); } catch (e) { $("#envLive").textContent = e.message; }
    }
    else if (act === "edit" && s) { closeMenu(); await openEdit(s); }
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
      logs[s.id] = { entries: [], next: null, base: 0 }; // the next poll reloads and shows the cleared marker
      markLogDirty();
    }
    else if (act === "wt-prune") {
      await api("POST", "/api/worktrees/prune", { dir: btn.dataset.dir || $("#wt-dir").value });
      await scanWt();
    }
    else if (act === "wt-remove") {
      if (!confirm(`Delete ${home(btn.dataset.path)}? It is an orphaned worktree folder, not a git repository.`)) return;
      try {
        await api("POST", "/api/worktrees/remove", { path: btn.dataset.path });
      } catch (e) {
        if (e.status === 409 && e.data?.names) {
          toastBusyWorktree(e.data.names, e.data.rootPids ?? [], btn.dataset.path, false, true);
          return;
        }
        throw e;
      }
      await scanWt();
    }
    else if (act === "wt-open") await api("POST", "/api/open", { path: btn.dataset.path });
    else if (act === "wt-import") {
      const result = await api("POST", "/api/import", { dir: btn.dataset.path });
      const n = (result.created ?? []).length;
      toast(n ? `Imported ${n} pin${n === 1 ? "" : "s"} from devboard.json` : "Nothing new to import");
      await scanWt();
      refresh();
    }
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
    else if (act === "stop-retire") {
      const pending = toastAction;
      toastText = "";
      toastAction = null;
      paintToast();
      if (!pending) return;
      for (const pid of pending.rootPids ?? []) await api("POST", "/api/kill", { rootPid: pid });
      const path = pending.remove ? "/api/worktrees/remove" : "/api/worktrees/retire";
      const body = pending.remove ? { path: pending.path } : { path: pending.path, force: pending.force };
      try {
        await api("POST", path, body);
      } catch (e) {
        if (e.status === 409) await api("POST", path, body);
        else throw e;
      }
      await scanWt();
    }
    else if (act === "wt-retire") {
      const forceNeeded = btn.dataset.dirty === "1" || btn.dataset.locked === "1";
      if (!confirm(forceNeeded
        ? `Retire ${home(btn.dataset.path)}? It is dirty or locked. This force-removes the checkout.`
        : `Retire ${home(btn.dataset.path)}? The branch stays in the repo.`)) return;
      try {
        await api("POST", "/api/worktrees/retire", { path: btn.dataset.path, force: forceNeeded });
      } catch (e) {
        if (e.status === 409 && e.data?.names) {
          toastBusyWorktree(e.data.names, e.data.rootPids ?? [], btn.dataset.path, forceNeeded, false);
          return;
        }
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
      markLogDirty();
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
      markLogDirty();
      for (const url of result.urls ?? []) {
        try { window.open(url, "_blank", "noopener"); } catch {}
      }
    }
    else if (act === "preset-edit") {
      openPresetForm(presets.find((x) => x.id === id));
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
$("#logFilter").oninput = (ev) => { logFilter = ev.target.value; markLogDirty(); paintLog(); };
$("#errChip").onclick = (ev) => {
  if (ev.shiftKey) { errOnly = !errOnly; markLogDirty(); paintLog(); }
  else nextErr();
};
$("#followBtn").onclick = () => {
  setFollow(true);
  $("#logBody").scrollTop = $("#logBody").scrollHeight;
  paintLog();
};
$("#logBody").addEventListener("scroll", () => {
  const b = $("#logBody");
  const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
  if (!atBottom && follow) { setFollow(false); paintLogTools(selected()); }
  else if (atBottom && !follow) { setFollow(true); paintLogTools(selected()); }
});
$("#overlay").addEventListener("click", (ev) => { if (ev.target === $("#overlay")) closeSheet(); });

async function loadImport(dir) {
  const btn = $("#a-import");
  if (!dir?.trim()) { btn.hidden = true; return; }
  try {
    const data = await api("GET", `/api/import?dir=${encodeURIComponent(dir.trim())}`);
    if (!data.exists || !data.importable) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = data.importable === 1 ? "Import 1 pin" : `Import ${data.importable} pins`;
  } catch {
    btn.hidden = true;
  }
}

$("#a-cwd").addEventListener("blur", () => {
  loadSuggest($("#a-cwd").value, "#a-suggest", "#a-cmd", "#a-port");
  loadImport($("#a-cwd").value);
});
$("#a-import").onclick = async () => {
  const dir = $("#a-cwd").value;
  try {
    const result = await api("POST", "/api/import", { dir });
    const n = (result.created ?? []).length;
    toast(n ? `Imported ${n} pin${n === 1 ? "" : "s"} from devboard.json` : "Nothing new to import");
    await loadImport(dir);
    refresh();
  } catch (e) {
    $("#addError").textContent = e.message;
  }
};
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
    const pending = restartAfterSave;
    let id = editingId;
    if (pending && !pending.pinned) {
      const created = await api("POST", "/api/pinned", body);
      id = created.pinned?.id ?? id;
    } else {
      await api("PUT", `/api/pinned/${encodeURIComponent(editingId)}`, body);
    }
    restartAfterSave = null;
    closeSheet();
    if (pending) await api("POST", "/api/restart", { id });
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
  const body = {
    name: data.name,
    serviceIds,
    urls: data.urls,
    worktree: data.worktree || undefined,
    openEditor: f.elements.openEditor.checked,
  };
  try {
    if (editingPresetId) await api("PUT", `/api/presets/${encodeURIComponent(editingPresetId)}`, body);
    else await api("POST", "/api/presets", body);
    editingPresetId = null;
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
    if (trace) { closeTrace(); return; }
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
setInterval(() => { if (sel) fetchLog(sel); }, 1000); // decision 4: 1s, matching `devboard logs -f`
