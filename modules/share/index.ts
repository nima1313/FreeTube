// What other apps send to FreeTele through Android's share sheet. See
// src/device/share.ts for how it reaches the page.
import { NativeModule, requireNativeModule } from 'expo';

export interface SharedFile {
  /** content:// URI, readable with open()/read(). */
  uri: string;
  name: string;
  mime: string;
  /** Bytes; -1 when the sending app doesn't say. */
  size: number;
}

export interface SharedItem {
  text: string | null;
  subject: string | null;
  files: SharedFile[];
}

type ShareEvents = {
  /** A share arrived while the app was running; call take() for it. */
  onShare(): void;
};

declare class ShareModule extends NativeModule<ShareEvents> {
  /** The waiting share, or null. Takes it: a second call returns null. */
  take(): SharedItem | null;
  /** Opens a shared file for reading; resolves to a handle. */
  open(uri: string): Promise<number>;
  /** Up to `max` bytes as base64, or null at the end of the file. */
  read(handle: number, max: number): Promise<string | null>;
  close(handle: number): Promise<void>;
}

export default requireNativeModule<ShareModule>('Share');
