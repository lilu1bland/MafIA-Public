const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  playerId: null,
  snapshot: null,
  myVote: null,
  clientId: localStorage.getItem("mafia-cid") || crypto.randomUUID(),
};

localStorage.setItem("mafia-cid", state.clientId);
$("name").value = localStorage.getItem("mafia-name") || "";

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    $("conn").textContent = "online";
    $("conn").style.color = "var(--ok)";
  };

  ws.onclose = () => {
    $("conn").textContent = "disconnected";
    $("conn").style.color = "var(--accent)";
    setTimeout(connect, 2500);
  };

  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handle(m) {
  if (m.t === "error") {
    $("home-error").textContent = m.msg;
    return;
  }
  if (m.t === "joined") {
    state.playerId = m.playerId;
    $("home-error").textContent = "";
    return;
  }
  if (m.t === "history") {
    $("messages").innerHTML = "";
    m.messages.forEach(addMessage);
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
    const label = document.createElement("span");
    label.textContent = p.name || "player";
    li.appendChild(label);
    if (p.id === s.hostId) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "host";
      li.appendChild(tag);
    }
    ul.appendChild(li);
  });

  const isHost = s.you.id === s.hostId;
  const sel = $("model-select");
  if (sel.querySelector(`option[value="${s.modelId}"]`)) sel.value = s.modelId;
  $("host-controls").hidden = !isHost;
  $("btn-start").disabled = humans < s.minPlayers;

  if (humans < s.minPlayers) {
    $("lobby-hint").textContent = `Waiting for ${s.minPlayers - humans} more player(s).`;
  } else {
    $("lobby-hint").textContent = `${humans} humans + ${bots} AI will play. ` +
      (isHost ? "You are the host." : "Waiting for the host to start.");
  }
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
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = p.colorCss;
    li.appendChild(sw);
    const label = document.createElement("span");
    label.textContent = p.name ? `${p.colorName} · ${p.name}` : p.colorName;
    li.appendChild(label);
    if (p.isAI !== undefined) {
      const tag = document.createElement("span");
      tag.className = p.isAI ? "tag ai" : "tag";
      tag.textContent = p.isAI ? "AI" : "human";
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
    banner.className = `result-banner ${s.winner}`;
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
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = p.colorCss;
    b.appendChild(sw);
    const label = document.createElement("span");
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
  skip.textContent = "Skip vote";
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
    author.textContent = msg.colorName + (msg.kind === "ai_private" ? " (AI)" : "");
    el.appendChild(author);
    const body = document.createElement("span");
    body.className = "body";
    if (msg.kind === "gif") {
      const img = document.createElement("img");
      img.src = msg.text;
      img.alt = "gif";
      body.appendChild(img);
    } else {
      body.textContent = msg.text;
    }
    el.appendChild(body);
  }

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

setInterval(() => {
  const s = state.snapshot;
  if (!s || s.phase === "lobby") return;
  const left = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
  $("phase-timer").textContent = left > 0 ? String(left) : "";
}, 250);

$("btn-create").onclick = () => {
  const name = $("name").value.trim();
  if (!name) return ($("home-error").textContent = "Pick a name first.");
  localStorage.setItem("mafia-name", name);
  send({ t: "create", name });
};

$("btn-join").onclick = () => {
  const name = $("name").value.trim();
  const code = $("code").value.trim();
  if (!name) return ($("home-error").textContent = "Pick a name first.");
  if (!/^\d{4}$/.test(code)) return ($("home-error").textContent = "Codes are four digits.");
  localStorage.setItem("mafia-name", name);
  send({ t: "join", name, code });
};

$("btn-start").onclick = () => send({ t: "start" });

$("model-select").onchange = (e) => send({ t: "model", modelId: e.target.value });

function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  send({ t: "chat", text });
  input.value = "";
}

$("btn-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
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

fetch("/api/models").then((r) => r.json()).then((models) => {
  const sel = $("model-select");
  sel.innerHTML = "";
  models.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  });
  if (state.snapshot) sel.value = state.snapshot.modelId;
});

connect();
