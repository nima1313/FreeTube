// Present the WebView as ordinary Chrome-for-Android: Google refuses sign-in
// when it detects an embedded WebView (the "; wv" token). Keep the Chrome major
// version roughly current with real Chrome releases.
export const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

// Schemes that hand off to the native YouTube app / Play Store — always blocked.
export const BLOCKED_SCHEMES = ['intent:', 'vnd.youtube:', 'market:'];
