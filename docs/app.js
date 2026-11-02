import { openRoom, randomId } from "./signal.js";
import { Peer } from "./p2p.js";

const $ = (id) => document.getElementById(id);
const screens = ["start", "invite", "chat", "fail"];
const show = (name) => screens.forEach((s) => ($(s).hidden = s !== name));

let room = null, signal = null, peer = null, helloTimer = 0, giveUp = 0, wakeLock = null;
let role = "host";
const outBubbles = new Map(), inBubbles = new Map();

function fmtSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

// ---- рукопожатие ----
function parseHash() {
  const m = location.hash.slice(1).split(".");
  return m.length === 2 && m[0] && m[1] ? { room: m[0], key: m[1] } : null;
}

async function begin(roomId, key, asRole) {
  role = asRole;
  signal = await openRoom(roomId, key, (m) => peer && peer.handle(m), (n) => {
    const st = role === "host" ? $("invite-status") : $("chat-status");
    if (n === 0 && !peer?.open) {
      st.textContent = "Нет связи с серверами рукопожатия…";
      st.className = "status err";
    } else if (!peer?.open) {
      st.textContent = role === "host" ? "Ждём второй телефон…" : "Соединяемся…";
      st.className = "status";
    }
  });
  peer = new Peer(role, signal, {
    onState: onPeerState,
    onText: (t) => addText("in", t),
    onFileStart: (m) => addFile("in", m.id, m.name, m.size),
    onFileProgress: (id, got, size) => progress(inBubbles.get(id), got, size, "Получаем"),
    onFileDone: onFileDone,
    onSent: (id) => meta(outBubbles.get(id), "Доставлено ✓", "ok", 1),
    onOutProgress: (id, sent, size) => progress(outBubbles.get(id), sent, size, "Отправляем"),
    onSendError: (id) => meta(outBubbles.get(id), "Не отправлено: связь прервалась", "err"),
  });
  if (role === "guest") {
    show("chat");
    setChatStatus("Соединяемся…", "");
    const hello = () => peer.hello();
    hello();
    helloTimer = setInterval(hello, 3000);
    giveUp = setTimeout(() => fail("Не удалось соединиться. Проверьте, что первый телефон не закрыл страницу, и попробуйте ещё раз."), 45000);
  }
}

function onPeerState(s) {
  if (s === "open") {
    clearInterval(helloTimer); clearTimeout(giveUp);
    show("chat");
    setChatStatus("Соединено напрямую ✓", "ok");
    keepAwake();
    setTimeout(() => { signal && signal.close(); signal = null; }, 3000);
  } else if (s === "failed") {
    fail("Не удалось соединиться напрямую. Бывает, если телефоны в разных сетях за строгим роутером. Попробуйте подключить оба к одной Wi-Fi сети.");
  } else if (s === "disconnected" || s === "closed") {
    if (!$("chat").hidden) setChatStatus("Связь прервалась", "err");
  }
}

function fail(text) {
  clearInterval(helloTimer); clearTimeout(giveUp);
  $("fail-text").textContent = text;
  show("fail");
}

function setChatStatus(text, cls) {
  const st = $("chat-status");
  st.textContent = text;
  st.className = "status " + cls;
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && peer?.open) keepAwake();
});

// ---- экраны ----
async function create() {
  const roomId = randomId(12), key = randomId(16);
  const url = `${location.origin}${location.pathname}#${roomId}.${key}`;
  const qr = qrcode(0, "M");
  qr.addData(url); qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("qr").dataset.url = url;
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(url); $("copy").textContent = "Скопировано ✓"; }
    catch (_) { prompt("Скопируйте ссылку:", url); }
  };
  if (navigator.share) {
    $("share").hidden = false;
    $("share").onclick = () => navigator.share({ title: "Тропка Онлайн", url }).catch(() => {});
  }
  show("invite");
  await begin(roomId, key, "host");
}

$("create").onclick = create;
$("again").onclick = () => { location.hash = ""; location.reload(); };

// ---- лента ----
function bubble(dir) {
  const b = document.createElement("div");
  b.className = "bubble " + dir;
  $("feed").appendChild(b);
  $("empty").hidden = true;
  b.scrollIntoView({ block: "end" });
  return b;
}

function addText(dir, text) {
  const b = bubble(dir);
  b.textContent = text;
}

function addFile(dir, id, name, size) {
  const b = bubble(dir);
  b.innerHTML = '<div class="name"></div><div class="meta"></div><div class="bar"><i></i></div>';
  b.querySelector(".name").textContent = name;
  b.querySelector(".meta").textContent = `${fmtSize(size)} · ${dir === "out" ? "в очереди" : "получаем…"}`;
  (dir === "out" ? outBubbles : inBubbles).set(id, b);
  return b;
}

function meta(b, text, cls = "", bar) {
  if (!b) return;
  const m = b.querySelector(".meta");
  m.textContent = text;
  m.className = "meta " + cls;
  if (bar !== undefined) b.querySelector(".bar > i").style.width = bar * 100 + "%";
}

function progress(b, done, size, label) {
  if (!b) return;
  const p = size ? done / size : 1;
  meta(b, `${label}: ${Math.floor(p * 100)}% · ${fmtSize(done)} из ${fmtSize(size)}`, "", p);
}

function onFileDone(id, blob, name) {
  const b = inBubbles.get(id);
  if (!b) return;
  const url = URL.createObjectURL(blob);
  meta(b, `${fmtSize(blob.size)} · получено ✓`, "ok", 1);
  if (blob.type.startsWith("image/") && blob.size < 30 * 1024 * 1024) {
    const img = document.createElement("img");
    img.className = "preview"; img.src = url; img.alt = name;
    b.appendChild(img);
  }
  const a = document.createElement("a");
  a.className = "btn small save"; a.href = url; a.download = name; a.textContent = "Сохранить";
  b.appendChild(a);
}

// ---- отправка ----
function sendFiles(files) {
  for (const f of files) {
    const id = randomId(6);
    addFile("out", id, f.name, f.size);
    peer.sendFile(id, f);
  }
}

$("attach").onclick = () => $("file").click();
$("file").onchange = () => { sendFiles([...$("file").files]); $("file").value = ""; };
$("composer").onsubmit = (e) => {
  e.preventDefault();
  const t = $("text").value.trim();
  if (!t || !peer?.open) return;
  peer.sendText(t);
  addText("out", t);
  $("text").value = "";
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  if (peer?.open && e.dataTransfer.files.length) sendFiles([...e.dataTransfer.files]);
});

// ---- старт ----
const h = parseHash();
if (h) begin(h.room, h.key, "guest");
else show("start");
