// Writes a file the page streams to us into the phone's public Downloads
// folder, chunk by chunk. See src/device/downloads.ts for why downloads don't
// go through react-native-webview's DownloadManager handoff.
import { requireNativeModule } from 'expo';

interface DownloadsModule {
  /** Creates the (pending, hidden) file. `id` names the transfer in later calls. */
  begin(id: string, name: string, mime: string): Promise<void>;
  /** Appends one base64-encoded chunk. */
  append(id: string, base64: string): Promise<void>;
  /** Closes and publishes the file; resolves to the name it was saved under. */
  finish(id: string): Promise<string>;
  /** Closes and deletes a partial file. Safe to call for an unknown id. */
  abort(id: string): Promise<void>;
}

export default requireNativeModule<DownloadsModule>('Downloads');
