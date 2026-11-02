// Сигнализация: перекидываем между телефонами зашифрованные сообщения рукопожатия
// через публичные серверы (ntfy.sh и MQTT-брокеры). Шлём по всем сразу, слушаем все сразу:
// если какой-то сервер недоступен (например, из России), работают остальные.
// Ключ шифрования живёт только во фрагменте ссылки (#…) и на серверы не уходит.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  to(buf) {
    let s = "";
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  from(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  },
};

export function randomId(bytes = 16) {
  return b64.to(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function importKey(keyStr) {
  return crypto.subtle.importKey("raw", b64.from(keyStr), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64.to(out);
}

async function open(key, str) {
  const all = b64.from(str);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---- ntfy.sh: публикация POST'ом, приём по WebSocket ----
function ntfyTransport(topic, onData, onState) {
  const name = "ntfy";
  let ws, closed = false, ready = false;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.event === "open") { ready = true; onState(name, true); }
        else if (m.event === "message" && m.message) onData(m.message);
      } catch (_) {}
    };
    ws.onclose = () => { ready = false; onState(name, false); if (!closed) setTimeout(connect, 3000); };
    ws.onerror = () => {};
  };
  connect();
  return {
    name,
    get ready() { return ready; },
    send(text) {
      fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: text }).catch(() => {});
    },
    close() { closed = true; try { ws.close(); } catch (_) {} },
  };
}

// ---- MQTT 3.1.1 поверх WebSocket (минимум: CONNECT, SUBSCRIBE, PUBLISH QoS 0, PING) ----
function mqttStr(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}
function mqttLen(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return out;
}

function mqttTransport(name, url, topic, onData, onState) {
  let ws, closed = false, ready = false, ping = 0, buf = new Uint8Array(0);
  const connect = () => {
    if (closed) return;
    buf = new Uint8Array(0);
    ws = new WebSocket(url, "mqtt");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const body = [...mqttStr("MQTT"), 4, 2, 0, 60, ...mqttStr("tropka-" + randomId(6))];
      ws.send(new Uint8Array([0x10, ...mqttLen(body.length), ...body]));
    };
    ws.onmessage = (e) => {
      const add = new Uint8Array(e.data);
      const all = new Uint8Array(buf.length + add.length);
      all.set(buf); all.set(add, buf.length);
      buf = all;
      for (;;) {
        if (buf.length < 2) return;
        let mul = 1, len = 0, i = 1, b;
        do {
          if (i >= buf.length) return;
          b = buf[i++]; len += (b & 127) * mul; mul *= 128;
        } while (b & 128);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, pkt = buf.slice(i, i + len);
        buf = buf.slice(i + len);
        if (type === 2) { // CONNACK → подписываемся
          const sub = [0, 1, ...mqttStr(topic), 0];
          ws.send(new Uint8Array([0x82, ...mqttLen(sub.length), ...sub]));
        } else if (type === 9) { // SUBACK
          ready = true; onState(name, true);
        } else if (type === 3) { // PUBLISH
          const tl = (pkt[0] << 8) | pkt[1];
          onData(dec.decode(pkt.slice(2 + tl)));
        }
      }
    };
    ws.onclose = () => {
      ready = false; clearInterval(ping); onState(name, false);
      if (!closed) setTimeout(connect, 3000);
    };
    ws.onerror = () => {};
    clearInterval(ping);
    ping = setInterval(() => { if (ws.readyState === 1) ws.send(new Uint8Array([0xc0, 0])); }, 30000);
  };
  connect();
  return {
    name,
    get ready() { return ready; },
    send(text) {
      if (ws.readyState !== 1 || !ready) return;
      const t = mqttStr(topic), p = enc.encode(text);
      const body = new Uint8Array([...t, ...p]);
      ws.send(new Uint8Array([0x30, ...mqttLen(body.length), ...body]));
    },
    close() { closed = true; clearInterval(ping); try { ws.close(); } catch (_) {} },
  };
}

/**
 * Комната: send(obj) шифрует и шлёт всем серверам; onMessage(obj) получает расшифрованное
 * (свои сообщения и повторы отбрасываются). onState(число рабочих серверов).
 */
export async function openRoom(room, keyStr, onMessage, onState) {
  const key = await importKey(keyStr);
  const me = randomId(8);
  const seen = new Set();
  const up = new Set();

  const onData = async (text) => {
    let env;
    try { env = JSON.parse(text); } catch (_) { return; }
    if (!env || env.f === me || seen.has(env.i)) return;
    seen.add(env.i);
    try { onMessage(await open(key, env.d)); } catch (_) { /* чужое или битое */ }
  };
  const state = (name, ok) => { ok ? up.add(name) : up.delete(name); onState(up.size); };

  const transports = [
    ntfyTransport("tropka-" + room, onData, state),
    mqttTransport("emqx", "wss://broker.emqx.io:8084/mqtt", "tropka/" + room, onData, state),
    mqttTransport("hivemq", "wss://broker.hivemq.com:8884/mqtt", "tropka/" + room, onData, state),
  ];

  return {
    async send(obj) {
      const text = JSON.stringify({ i: randomId(6), f: me, d: await seal(key, obj) });
      for (const t of transports) t.send(text);
    },
    close() { transports.forEach((t) => t.close()); },
  };
}
