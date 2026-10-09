// Writes a file the page streams to us into the phone's public Downloads
// folder, chunk by chunk. See src/device/downloads.ts for why downloads don't
// go through react-native-webview's DownloadManager handoff.
import { requireNativeModule } from 'expo';

interface DownloadsModule {
  /** Creates the (pending, hidden) file. `id` names the transfer in later calls. */
  begin(id: string, name: string, mime: string): Promise<void>;
  /** Appends one base64-encoded chunk. */
  append(id: string, base64: string): Promise<void>;
  /**
   * Closes and publishes the file; resolves to the name it was saved under.
   * With a key, the file is remembered for saved() and open().
   */
  finish(id: string, key: string | null): Promise<string>;
  /** Closes and deletes a partial file. Safe to call for an unknown id. */
  abort(id: string): Promise<void>;
  /** Keys of remembered files that still exist; forgets the deleted ones. */
  saved(): Promise<string[]>;
  /**
   * Opens a remembered file with the app that handles its type. Resolves
   * false if the file is gone; rejects if no app can open it.
   */
  open(key: string): Promise<boolean>;
}

export default requireNativeModule<DownloadsModule>('Downloads');
