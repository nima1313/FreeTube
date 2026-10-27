// FreeTele in Android's share sheet. The intent filters (app.config.ts,
// shareTarget) bring a share to the local Share module; this passes it into
// the page, where the bootstrap's "Share target" section hands it to Telegram
// Web's own share handling: Telegram's chat picker, then the usual caption
// popup for files, or a draft in the chosen chat for text.
//
// Files go in as base64 chunks through injectJavaScript, the reverse of
// downloads.ts. The page acknowledges every chunk, so a big video is never
// queued up whole in the WebView's script queue; the next chunk is read from
// the file while the page is still taking the last one. Most of the time
// per chunk is the round trip, not the data, hence the big chunks: 60 MB
// took ~9s in 384 KB chunks on the emulator.
//
// Like downloads.ts, nothing here throws: a failed share ends in a toast.
import { ToastAndroid } from 'react-native';
import Share, { SharedItem } from '../../modules/share';
import type { Inject } from './downloads';

// 1.5 MB of file → 2 MB of base64 per injectJavaScript call.
const CHUNK = 1536 * 1024;
const ACK_TIMEOUT_MS = 30_000;

export interface ShareMessage {
  type: 'share';
  phase: 'ack';
}

const queue: SharedItem[] = [];
let busy = false;
let pageReady = false;
let inject: Inject | null = null;
let ackWaiter: (() => void) | null = null;

function call(fn: string, ...args: unknown[]): string {
  return (
    'window.__unhook && window.__unhook.' +
    fn +
    '(' +
    args.map((a) => JSON.stringify(a)).join(',') +
    ');true;'
  );
}

function nextAck(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiter = null;
      resolve(false);
    }, ACK_TIMEOUT_MS);
    ackWaiter = () => {
      clearTimeout(timer);
      ackWaiter = null;
      resolve(true);
    };
  });
}

export function handleShareMessage(msg: ShareMessage): void {
  if (msg.phase === 'ack') ackWaiter?.();
}

async function deliver(item: SharedItem, run: Inject): Promise<void> {
  run(
    call('shareBegin', {
      text: item.text,
      subject: item.subject,
      files: item.files.map((f) => ({ name: f.name, mime: f.mime, size: f.size })),
    })
  );
  for (let i = 0; i < item.files.length; i++) {
    const handle = await Share.open(item.files[i].uri);
    try {
      let data = await Share.read(handle, CHUNK);
      while (data != null) {
        const acked = nextAck();
        run(call('shareChunk', i, data));
        const next = Share.read(handle, CHUNK);
        if (!(await acked)) {
          next.catch(() => {});
          throw new Error('the page stopped answering');
        }
        data = await next;
      }
    } finally {
      Share.close(handle).catch(() => {});
    }
  }
  run(call('shareEnd'));
}

async function pump(): Promise<void> {
  if (busy || !pageReady || !inject) return;
  const item = queue.shift();
  if (!item) return;
  busy = true;
  const run = inject;
  try {
    await deliver(item, run);
  } catch (e) {
    if (__DEV__) console.log('[unhook] share failed', e);
    run(call('shareAbort'));
    ToastAndroid.show('Could not share to Telegram', ToastAndroid.SHORT);
  } finally {
    busy = false;
    pump();
  }
}

function take(): void {
  const item = Share.take();
  if (item) {
    queue.push(item);
    pump();
  }
}

/**
 * Starts listening for shares; returns the unsubscribe. Picks up the share
 * that launched the app, if any.
 */
export function startShareTarget(run: Inject): () => void {
  inject = run;
  const sub = Share.addListener('onShare', take);
  take();
  return () => {
    sub.remove();
    inject = null;
  };
}

/**
 * Whether the page can take a share: false from the start of a page load
 * until it has finished and the bootstrap is in. The page itself waits for
 * Telegram to be ready.
 */
export function setSharePageReady(ready: boolean): void {
  pageReady = ready;
  if (ready) pump();
}
