// osc-ws.js · WebSocket client for bridge/bridge.mjs
// Messages are JSON {path, args}. Reconnects with backoff. Never throws into
// the caller: a dead socket only changes `connected`.

export class OscWs {
  constructor(url, onMessage, onState) {
    this.url = url;
    this.onMessage = onMessage;
    this.onState = onState || (() => {});
    this.connected = false;
    this.ws = null;
    this.retry = 500;
    this.closed = false;
    this.rx = 0;
    this.tx = 0;
    this.open();
  }
  open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.schedule(); return; }
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 500; this.onState(true); };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.onState(false);
      this.schedule();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.path !== "string") return;
      this.rx++;
      try { this.onMessage(m.path, Array.isArray(m.args) ? m.args : [], m); } catch (e) { console.warn("osc-ws handler", e); }
    };
  }
  schedule() {
    if (this.closed) return;
    setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 5000);
  }
  send(path, args = []) {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify({ path, args })); this.tx++; return true; } catch { return false; }
  }
  close() { this.closed = true; try { this.ws && this.ws.close(); } catch {} }
}
