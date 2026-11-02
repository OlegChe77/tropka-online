// Прямое соединение двух телефонов (WebRTC DataChannel) и передача файлов/текста по нему.

const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }] };
const CHUNK = 16 * 1024;          // размер одного сообщения: безопасно для всех браузеров
const BLOCK = 1024 * 1024;        // читаем с диска блоками
const HIGH = 1024 * 1024;         // не копим в буфере больше этого

function gathered(pc, ms = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => { pc.removeEventListener("icegatheringstatechange", check); clearTimeout(t); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const t = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Один конец связи. role: "host" (создал комнату, шлёт offer) или "guest" (отвечает).
 * signal.send(obj) — отправка рукопожатия; handle(obj) — приём; events: onState, onText, onFileStart,
 * onFileProgress, onFileDone, onSent (доставлено), onOutProgress.
 */
export class Peer {
  constructor(role, signal, ev) {
    this.role = role; this.signal = signal; this.ev = ev;
    this.pc = new RTCPeerConnection(ICE);
    this.dc = null;
    this.offerP = null; this.answerP = null;
    this.incoming = null;
    this.queue = []; this.sending = false;
    this.pc.onconnectionstatechange = () => ev.onState(this.pc.connectionState);
    if (role === "host") {
      this._setup(this.pc.createDataChannel("tropka", { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this._setup(e.channel);
    }
  }

  get open() { return this.dc && this.dc.readyState === "open"; }

  _setup(dc) {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = HIGH / 4;
    this.dc = dc;
    dc.onopen = () => this.ev.onState("open");
    dc.onclose = () => this.ev.onState("closed");
    dc.onmessage = (e) => this._onMessage(e.data);
  }

  // ---- рукопожатие ----
  async handle(m) {
    if (this.open) return;
    if (this.role === "host" && m.t === "hello") {
      this.offerP ||= (async () => {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await gathered(this.pc);
        return this.pc.localDescription.sdp;
      })();
      this.signal.send({ t: "offer", sdp: await this.offerP });
    } else if (this.role === "host" && m.t === "answer") {
      if (this.pc.signalingState === "have-local-offer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      }
    } else if (this.role === "guest" && m.t === "offer") {
      this.answerP ||= (async () => {
        await this.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await gathered(this.pc);
        return this.pc.localDescription.sdp;
      })();
      this.signal.send({ t: "answer", sdp: await this.answerP });
    }
  }

  hello() { this.signal.send({ t: "hello" }); }

  close() { try { this.pc.close(); } catch (_) {} }

  // ---- приём ----
  _onMessage(data) {
    if (typeof data !== "string") {
      const f = this.incoming;
      if (!f) return;
      f.chunks.push(data);
      f.got += data.byteLength;
      this.ev.onFileProgress(f.id, f.got, f.size);
      if (f.got >= f.size) this._finishIncoming();
      return;
    }
    const m = JSON.parse(data);
    if (m.t === "text") this.ev.onText(m.text);
    else if (m.t === "file") {
      this.incoming = { id: m.id, name: m.name, size: m.size, type: m.type, chunks: [], got: 0 };
      this.ev.onFileStart(m);
      if (m.size === 0) this._finishIncoming();
    } else if (m.t === "got") this.ev.onSent(m.id);
  }

  _finishIncoming() {
    const f = this.incoming; this.incoming = null;
    const blob = new Blob(f.chunks, { type: f.type || "application/octet-stream" });
    this.ev.onFileDone(f.id, blob, f.name);
    this.dc.send(JSON.stringify({ t: "got", id: f.id }));
  }

  // ---- отправка ----
  sendText(text) {
    this.dc.send(JSON.stringify({ t: "text", text }));
  }

  sendFile(id, file) {
    this.queue.push({ id, file });
    if (!this.sending) this._pump();
  }

  async _pump() {
    this.sending = true;
    while (this.queue.length && this.open) {
      const { id, file } = this.queue.shift();
      try {
        this.dc.send(JSON.stringify({ t: "file", id, name: file.name, size: file.size, type: file.type }));
        for (let off = 0; off < file.size; off += BLOCK) {
          const block = new Uint8Array(await file.slice(off, off + BLOCK).arrayBuffer());
          for (let i = 0; i < block.length; i += CHUNK) {
            if (!this.open) throw new Error("closed");
            if (this.dc.bufferedAmount > HIGH) await this._drain();
            this.dc.send(block.subarray(i, i + CHUNK));
          }
          this.ev.onOutProgress(id, Math.max(0, off + block.length - this.dc.bufferedAmount), file.size);
        }
        this.ev.onOutProgress(id, file.size, file.size);
      } catch (_) {
        this.ev.onSendError(id);
      }
    }
    this.sending = false;
  }

  _drain() {
    return new Promise((resolve) => {
      const dc = this.dc;
      const done = () => { dc.removeEventListener("bufferedamountlow", done); clearInterval(t); resolve(); };
      dc.addEventListener("bufferedamountlow", done);
      const t = setInterval(() => { if (!this.open || dc.bufferedAmount <= HIGH / 4) done(); }, 200);
    });
  }
}
