const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  playerId: null,
  snapshot: null,
  myVote: null,
  presence: { online: 0, lobbies: [] },
  models: [],
  clientId: localStorage.getItem("mafia-cid") || crypto.randomUUID(),
  session: null,
  resumeTried: false,
};

localStorage.setItem("mafia-cid", state.clientId);
$("name").value = localStorage.getItem("mafia-name") || "";

try {
  state.session = JSON.parse(localStorage.getItem("mafia-session") || "null");
} catch {
  state.session = null;
}

function saveSession(code, token) {
  state.session = { code, token };
  localStorage.setItem("mafia-session", JSON.stringify(state.session));
}

function clearSession() {
  state.session = null;
  localStorage.removeItem("mafia-session");
  $("reconnect-bar").hidden = true;
}

function connect() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    $("conn").textContent = "online";
    $("conn").style.color = "green";
    if (state.session) {
      send({ t: "resume", code: state.session.code, token: state.session.token });
    }
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    $("conn").textContent = "reconnecting";
    $("conn").style.color = "red";
    setTimeout(connect, 2000);
  };

  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    handle(JSON.parse(ev.data));
  };
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") connect();
});

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handle(m) {
  if (m.t === "presence") {
    state.presence = m;
    renderPresence();
    return;
  }
  if (m.t === "error") {
    $("home-error").textContent = m.msg;
    return;
  }
  if (m.t === "resume_failed") {
    state.resumeTried = true;
    clearSession();
    state.snapshot = null;
    showScreen("screen-home");
    return;
  }
  if (m.t === "joined") {
    state.playerId = m.playerId;
    state.resumeTried = true;
    saveSession(m.code, m.token);
    $("home-error").textContent = "";
    $("reconnect-bar").hidden = true;
    return;
  }
  if (m.t === "history") {
    const box = $("messages");
    box.innerHTML = "";
    m.messages.forEach(addMessage);
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (m.t === "msg") {
    addMessage(m.msg);
    return;
  }
  if (m.t === "state") {
    const prevPhase = state.snapshot && state.snapshot.phase;
    state.snapshot = m;
    if (prevPhase !== m.phase) state.myVote = null;
    render();
  }
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  if (id !== "screen-game") closeDrawer();
}

function renderPresence() {
  const p = state.presence;
  $("online-count").textContent = `${p.online} online`;

  const ul = $("lobby-list");
  ul.innerHTML = "";
  const lobbies = p.lobbies || [];
  $("lobby-list-empty").hidden = lobbies.length > 0;
  lobbies.forEach((l) => {
    const li = document.createElement("li");
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = l.code;
    li.appendChild(code);
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = `${l.hostName} - ${l.modelLabel}`;
    li.appendChild(label);
    const count = document.createElement("span");
    count.className = "tag";
    count.textContent = `${l.players}/${l.maxPlayers}`;
    li.appendChild(count);
    const join = document.createElement("button");
    join.textContent = "Join";
    join.onclick = () => joinCode(l.code);
    li.appendChild(join);
    ul.appendChild(li);
  });
}

function render() {
  const s = state.snapshot;
  if (!s) return;
  if (s.phase === "lobby") {
    showScreen("screen-lobby");
    renderLobby(s);
  } else {
    showScreen("screen-game");
    renderGame(s);
  }
}

function renderLobby(s) {
  $("lobby-code").textContent = s.code;
  const humans = s.players.length;
  const bots = Math.max(1, Math.floor(humans / 3));
  $("lobby-count").textContent = `${humans} / ${s.maxPlayers} players`;
  $("lobby-model").textContent = s.modelLabel;

  const ul = $("lobby-players");
  ul.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("offline");
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = p.name || "player";
    li.appendChild(label);
    if (!p.connected) {
      const off = document.createElement("span");
      off.className = "tag off";
      off.textContent = "disconnected";
      li.appendChild(off);
    }
    if (p.id === s.hostId) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "host";
      li.appendChild(tag);
    }
    ul.appendChild(li);
  });

  const isHost = s.you.id === s.hostId;
  $("lobby-visibility").value = s.isPublic ? "public" : "private";
  $("learn-toggle").checked = !!s.lobbyMemory;
  renderAiConfig(s);
  $("host-controls").hidden = !isHost;
  $("btn-start").disabled = humans < s.minPlayers;

  if (humans < s.minPlayers) {
    $("lobby-hint").textContent = `Waiting for ${s.minPlayers - humans} more player(s).`;
  } else {
    $("lobby-hint").textContent = `${humans} humans + ${s.aiCount} AI will play. ` +
      (isHost ? "You are the host." : "Waiting for the host to start.");
  }
}

function renderAiConfig(s) {
  const countSel = $("ai-count");
  const maxAi = Math.max(1, Math.min(5, s.players.length - 1));
  if (countSel.dataset.max !== String(maxAi)) {
    countSel.dataset.max = String(maxAi);
    countSel.innerHTML = "";
    for (let n = 1; n <= maxAi; n++) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      countSel.appendChild(o);
    }
  }
  countSel.value = String(Math.min(s.aiCount, maxAi));

  const box = $("ai-models");
  const want = s.aiModels.join(",");
  if (box.dataset.sig === want && box.children.length === s.aiModels.length) return;
  box.dataset.sig = want;
  box.innerHTML = "";
  s.aiModels.forEach((mid, i) => {
    const sel = document.createElement("select");
    state.models.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.value = mid;
    sel.onchange = () => {
      const ids = [...box.querySelectorAll("select")].map((x) => x.value);
      send({ t: "aimodels", aiModels: ids });
    };
    const row = document.createElement("div");
    row.className = "ai-seat";
    const tag = document.createElement("span");
    tag.textContent = `AI ${i + 1}`;
    row.appendChild(tag);
    row.appendChild(sel);
    box.appendChild(row);
  });
}

function renderGame(s) {
  const labels = {
    day: `Day ${s.day} — discuss`,
    vote: `Day ${s.day} — vote`,
    reveal: "Results",
    night: "Night",
    over: s.winner === "humans" ? "Humans win" : "AI win",
  };
  $("phase-label").textContent = labels[s.phase] || s.phase;

  const dead = !s.you.alive;
  $("composer").hidden = dead || s.phase === "over";
  $("spectator-bar").hidden = !dead;
  $("sidebar-title").textContent = dead || s.phase === "over" ? "Players (revealed)" : "Players";

  const ul = $("game-players");
  ul.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    if (!p.alive) li.classList.add("dead");
    if (!p.connected) li.classList.add("offline");
    const label = document.createElement("span");
    label.className = "grow";
    label.style.color = p.colorCss;
    label.textContent = p.isAI ? p.colorName : (p.name ? `${p.colorName} - ${p.name}` : p.colorName);
    li.appendChild(label);
    if (!p.connected) {
      const off = document.createElement("span");
      off.className = "tag off";
      off.textContent = "offline";
      li.appendChild(off);
    }
    if (p.isAI !== undefined) {
      const tag = document.createElement("span");
      tag.className = p.isAI ? "tag ai" : "tag";
      tag.textContent = p.isAI ? (p.name || "AI") : "human";
      li.appendChild(tag);
    } else if (p.id === s.you.id) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "you";
      li.appendChild(tag);
    }
    ul.appendChild(li);
  });

  const canVote = s.phase === "vote" && s.you.alive;
  $("vote-panel").hidden = !canVote;
  if (canVote) renderVote(s);

  const banner = $("result-banner");
  if (s.phase === "over") {
    banner.hidden = false;
    banner.textContent = s.winner === "humans"
      ? "The humans found every AI."
      : "The AI outnumber the humans.";
  } else {
    banner.hidden = true;
  }
}

function renderVote(s) {
  const box = $("vote-options");
  box.innerHTML = "";
  const options = s.players.filter((p) => p.alive && p.id !== s.you.id);
  options.forEach((p) => {
    const b = document.createElement("button");
    if (state.myVote === p.id) b.classList.add("chosen");
    const label = document.createElement("span");
    label.className = "grow";
    label.style.color = p.colorCss;
    label.textContent = p.colorName;
    b.appendChild(label);
    const count = document.createElement("span");
    count.className = "vote-count";
    count.textContent = (s.votes && s.votes[p.id]) || "";
    b.appendChild(count);
    b.onclick = () => {
      state.myVote = p.id;
      send({ t: "vote", target: p.id });
      renderVote(s);
    };
    box.appendChild(b);
  });

  const skip = document.createElement("button");
  if (state.myVote === "skip") skip.classList.add("chosen");
  const skipLabel = document.createElement("span");
  skipLabel.className = "grow";
  skipLabel.textContent = "Skip vote";
  skip.appendChild(skipLabel);
  const sc = document.createElement("span");
  sc.className = "vote-count";
  sc.textContent = (s.votes && s.votes.skip) || "";
  skip.appendChild(sc);
  skip.onclick = () => {
    state.myVote = "skip";
    send({ t: "vote", target: "skip" });
    renderVote(s);
  };
  box.appendChild(skip);
}

function addMessage(msg) {
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "msg";

  if (msg.kind === "system") {
    el.classList.add("system");
    el.textContent = msg.text;
  } else {
    if (msg.kind === "ai_private") el.classList.add("private");
    const author = document.createElement("span");
    author.className = "author";
    author.style.color = msg.colorCss;
    author.textContent = msg.kind === "ai_private" && msg.authorName
      ? msg.authorName
      : msg.colorName;
    el.appendChild(author);
    const body = document.createElement("span");
    if (msg.kind === "gif") {
      const img = document.createElement("img");
      img.src = msg.text;
      img.alt = "gif";
      img.onload = () => (box.scrollTop = box.scrollHeight);
      body.appendChild(img);
    } else {
      body.textContent = msg.text;
    }
    el.appendChild(body);
  }

  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function openDrawer() {
  $("sidebar").classList.add("open");
  $("drawer-scrim").hidden = false;
}

function closeDrawer() {
  $("sidebar").classList.remove("open");
  $("drawer-scrim").hidden = true;
}

setInterval(() => {
  const s = state.snapshot;
  const el = $("phase-timer");
  if (!s || s.phase === "lobby" || s.phase === "over") {
    el.textContent = "--";
    return;
  }
  const left = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
  el.textContent = left + "s";
}, 250);

function requireName() {
  const name = $("name").value.trim();
  if (!name) {
    $("home-error").textContent = "Pick a name first.";
    return null;
  }
  localStorage.setItem("mafia-name", name);
  return name;
}

function joinCode(code) {
  const name = requireName();
  if (!name) return;
  send({ t: "join", name, code });
}

$("btn-create").onclick = () => {
  const name = requireName();
  if (!name) return;
  send({
    t: "create",
    name,
    isPublic: $("visibility").value === "public",
    maxPlayers: Number($("max-players").value),
  });
};

$("btn-join").onclick = () => {
  const code = $("code").value.trim();
  if (!/^\d{4}$/.test(code)) return ($("home-error").textContent = "Codes are four digits.");
  joinCode(code);
};

$("btn-reconnect").onclick = () => {
  if (!state.session) return;
  send({ t: "resume", code: state.session.code, token: state.session.token });
};

$("btn-forget").onclick = clearSession;

$("btn-leave-lobby").onclick = () => {
  send({ t: "leave" });
  clearSession();
  state.snapshot = null;
  showScreen("screen-home");
};

$("btn-start").onclick = () => send({ t: "start" });
$("ai-count").onchange = (e) => send({ t: "aicount", aiCount: Number(e.target.value) });
$("lobby-visibility").onchange = (e) =>
  send({ t: "visibility", isPublic: e.target.value === "public" });
$("learn-toggle").onchange = (e) => send({ t: "learn", learn: e.target.checked });

$("btn-drawer").onclick = openDrawer;
$("btn-drawer-close").onclick = closeDrawer;
$("drawer-scrim").onclick = closeDrawer;

function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  send({ t: "chat", text });
  input.value = "";
}

$("btn-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

$("btn-gif").onclick = () => {
  $("gif-modal").hidden = false;
  loadGifs("");
};
$("gif-close").onclick = () => ($("gif-modal").hidden = true);

let gifTimer = null;
$("gif-search").addEventListener("input", (e) => {
  clearTimeout(gifTimer);
  const q = e.target.value;
  gifTimer = setTimeout(() => loadGifs(q), 350);
});

async function loadGifs(q) {
  const box = $("gif-results");
  box.innerHTML = "";
  $("gif-note").textContent = "Loading…";
  const r = await fetch(`/api/gifs?q=${encodeURIComponent(q)}&cid=${state.clientId}`);
  const gifs = await r.json();
  $("gif-note").textContent = gifs.length ? "" : "No GIFs. Is KLIPY_API_KEY set on the server?";
  gifs.forEach((g) => {
    const img = document.createElement("img");
    img.src = g.preview;
    img.loading = "lazy";
    img.onclick = () => {
      send({ t: "gif", url: g.url });
      $("gif-modal").hidden = true;
    };
    box.appendChild(img);
  });
}

$("btn-stats").onclick = async () => {
  $("stats-modal").hidden = false;
  const body = $("stats-body");
  body.innerHTML = "<p class='hint'>Loading…</p>";
  const rows = await (await fetch("/api/stats")).json();
  if (!rows.length) {
    body.innerHTML = "<p class='hint'>No completed matches yet.</p>";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Model</th><th class='num'>Games</th><th class='num'>AI win %</th>" +
    "<th class='num'>Survival %</th><th class='num'>Messages</th></tr></thead>";
  const tbody = document.createElement("tbody");
  rows.forEach((s) => {
    const tr = document.createElement("tr");
    const winRate = ((s.aiWins / s.games) * 100).toFixed(0);
    const survival = s.aiSeats ? ((s.aiSurvived / s.aiSeats) * 100).toFixed(0) : "0";
    tr.innerHTML = `<td>${s.label}</td><td class='num'>${s.games}</td>` +
      `<td class='num'>${winRate}%</td><td class='num'>${survival}%</td>` +
      `<td class='num'>${s.messagesSent}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  body.innerHTML = "";
  body.appendChild(table);
};

$("stats-close").onclick = () => ($("stats-modal").hidden = true);

const capSelect = $("max-players");
for (let n = 3; n <= 15; n++) {
  const o = document.createElement("option");
  o.value = String(n);
  o.textContent = `${n} players`;
  if (n === 8) o.selected = true;
  capSelect.appendChild(o);
}

fetch("/api/models").then((r) => r.json()).then((models) => {
  state.models = models;
  if (state.snapshot) renderAiConfig(state.snapshot);
});

if (state.session) {
  $("reconnect-bar").hidden = false;
  $("reconnect-text").textContent = `You were in lobby ${state.session.code}.`;
}

connect();
