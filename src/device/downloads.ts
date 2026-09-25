// Saves files the page streams to us (see the Downloads section of
// src/injection/bootstrap.ts for why react-native-webview's own DownloadManager
// handoff can't be used for Telegram). The page posts start → chunk… → end (or
// error) for each download; this turns them into calls on the local Downloads
// module, which writes into the phone's Downloads folder.
//
// Like screen.ts, nothing here throws: a failed download must never interrupt
// browsing, so failures end in a toast and a deleted partial file.
import { ToastAndroid } from 'react-native';
import Downloads from '../../modules/downloads';

export interface DownloadMessage {
  type: 'download';
  phase: 'start' | 'chunk' | 'end' | 'error';
  id: string;
  name?: string;
  mime?: string;
  size?: number;
  data?: string;
  started?: boolean;
  reason?: string;
}

interface Transfer {
  name: string;
  /**
   * Every native call for this download is chained here, so begin → append… →
   * finish reach the module strictly in order however the bridge schedules them.
   */
  chain: Promise<void>;
  failed: boolean;
}

const transfers = new Map<string, Transfer>();

function toast(text: string): void {
  ToastAndroid.show(text, ToastAndroid.SHORT);
}

function fail(id: string, t: Transfer, why: unknown): void {
  if (t.failed) return;
  t.failed = true;
  transfers.delete(id);
  if (__DEV__) console.log('[unhook] download failed', id, why);
  Downloads.abort(id).catch(() => {});
  toast('Download failed: ' + t.name);
}

function enqueue(id: string, t: Transfer, step: () => Promise<unknown>): void {
  t.chain = t.chain.then(async () => {
    if (t.failed) return;
    try {
      await step();
    } catch (e) {
      fail(id, t, e);
    }
  });
}

export function handleDownloadMessage(msg: DownloadMessage): void {
  const { id } = msg;
  if (!id) return;

  if (msg.phase === 'start') {
    const name = msg.name || 'download';
    const t: Transfer = { name, chain: Promise.resolve(), failed: false };
    transfers.set(id, t);
    toast('Downloading ' + name);
    enqueue(id, t, () => Downloads.begin(id, name, msg.mime || 'application/octet-stream'));
    return;
  }

  const t = transfers.get(id);
  if (!t) {
    // Failed before anything was written (e.g. the fetch itself was refused).
    if (msg.phase === 'error' && !msg.started) toast('Download failed' + (msg.name ? ': ' + msg.name : ''));
    return;
  }

  if (msg.phase === 'chunk' && msg.data) {
    const data = msg.data;
    enqueue(id, t, () => Downloads.append(id, data));
  } else if (msg.phase === 'end') {
    enqueue(id, t, async () => {
      const saved = await Downloads.finish(id);
      transfers.delete(id);
      toast('Saved ' + saved + ' to Downloads');
    });
  } else if (msg.phase === 'error') {
    enqueue(id, t, () => Promise.reject(new Error(msg.reason || 'stream error')));
  }
}
