// WebSocket connection: JSON for control messages, binary for hot paths.

import type { C2S, S2C } from "../../shared/protocol.ts";

export type JsonHandler = (msg: S2C) => void;
export type BinHandler = (op: number, view: DataView, buf: ArrayBuffer) => void;

/** clankersmp: all a spectator ever sends (never a move or an action). */
const WATCH_ONLY = new Set<C2S["t"]>(["hello", "ping", "resync", "follow"]);

export class Net {
  ws: WebSocket | null = null;
  onJson: JsonHandler = () => {};
  onBin: BinHandler = () => {};
  onClose: (code: number, reason: string) => void = () => {};
  bytesIn = 0;
  bytesOut = 0;
  rtt = 0;
  /** clankersmp: a spectator's connection: everything but WATCH_ONLY is dropped here. */
  watchOnly = false;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(timeoutMs = 12000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error("Connection timed out"));
        }
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Could not connect to the server"));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the server"));
          return;
        }
        this.onClose(e.code, e.reason);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          this.bytesIn += e.data.length;
          let msg: S2C;
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }
          this.onJson(msg);
        } else {
          const buf = e.data as ArrayBuffer;
          this.bytesIn += buf.byteLength;
          if (buf.byteLength < 1) return;
          const view = new DataView(buf);
          this.onBin(view.getUint8(0), view, buf);
        }
      };
    });
  }

  get open(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: C2S): void {
    if (!this.open || (this.watchOnly && !WATCH_ONLY.has(msg.t))) return;
    const s = JSON.stringify(msg);
    this.bytesOut += s.length;
    this.ws!.send(s);
  }

  sendBin(buf: ArrayBuffer): void {
    if (!this.open || this.watchOnly) return;
    this.bytesOut += buf.byteLength;
    this.ws!.send(buf);
  }

  close(): void {
    this.ws?.close();
  }
}

/** Inflate a deflate-raw payload (EDITS / WORLD messages). */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
