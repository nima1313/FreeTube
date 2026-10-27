package com.nima.share

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.InputStream

// Set on an intent once its share has been picked up, so neither a second
// look at the same activity intent nor a recreated activity shares it twice.
private const val TAKEN = "com.nima.share.TAKEN"

private class UnreadableException(uri: String) :
  CodedException("Could not open '$uri'")

private class UnknownReaderException(handle: Int) :
  CodedException("No open file '$handle'")

/**
 * Receives what other apps send through Android's share sheet (the manifest's
 * SEND / SEND_MULTIPLE intent filters, FreeTele only) and lets JS read the
 * shared files in chunks to pass into the page.
 *
 * A share arrives either as the intent that started the app (cold start: JS
 * asks with take() when it mounts) or as a new intent to the running app
 * (singleTask), which is announced with the onShare event; JS then calls
 * take(). The read permission for shared content:// URIs comes with the
 * intent and lasts while the app's task does.
 */
class ShareModule : Module() {
  private var pending: Map<String, Any?>? = null
  private val readers = mutableMapOf<Int, InputStream>()
  private var nextReader = 1

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("Share")

    Events("onShare")

    // The waiting share, or null. Takes it: a second call returns null.
    Function("take") {
      appContext.currentActivity?.let { pickUp(it.intent) }
      val p = pending
      pending = null
      p
    }

    OnNewIntent { intent ->
      if (pickUp(intent)) sendEvent("onShare", mapOf<String, Any>())
    }

    // An activity recreated while the app process lived on keeps its intent
    // but mounts no new JS, so nothing would call take() for it.
    OnActivityEntersForeground {
      val activity = appContext.currentActivity
      if (activity != null && pickUp(activity.intent)) sendEvent("onShare", mapOf<String, Any>())
    }

    AsyncFunction("open") { uri: String ->
      val stream = try {
        context.contentResolver.openInputStream(Uri.parse(uri))
      } catch (e: Exception) {
        null
      } ?: throw UnreadableException(uri)
      synchronized(readers) {
        val handle = nextReader++
        readers[handle] = stream
        handle
      }
    }

    // Up to `max` bytes as base64, or null at the end of the file.
    AsyncFunction("read") { handle: Int, max: Int ->
      val stream = synchronized(readers) { readers[handle] } ?: throw UnknownReaderException(handle)
      val buf = ByteArray(max)
      var n = 0
      while (n < max) {
        val r = stream.read(buf, n, max - n)
        if (r < 0) break
        n += r
      }
      if (n == 0) null else Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
    }

    AsyncFunction("close") { handle: Int ->
      synchronized(readers) { readers.remove(handle) }?.let { runCatching { it.close() } }
    }

    OnDestroy {
      synchronized(readers) {
        readers.values.forEach { runCatching { it.close() } }
        readers.clear()
      }
    }
  }

  /** Stores the share in [intent] as pending, once. True if there was one. */
  private fun pickUp(intent: Intent?): Boolean {
    if (intent == null || intent.getBooleanExtra(TAKEN, false)) return false
    val share = parse(intent) ?: return false
    intent.putExtra(TAKEN, true)
    pending = share
    return true
  }

  private fun parse(intent: Intent): Map<String, Any?>? {
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      streamExtra(intent)?.let { uris.add(it) }
    } else {
      streamListExtra(intent)?.let { uris.addAll(it) }
    }
    // Some apps only put the files in ClipData (where the read grant lives).
    if (uris.isEmpty()) {
      val clip = intent.clipData
      if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
    }

    val files = uris.distinct().map { describe(it, intent.type) }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() }
    if (files.isEmpty() && text == null) return null
    return mapOf("text" to text, "subject" to subject, "files" to files)
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri>? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)

  /** Name and type for one shared file; the page needs both to build a File. */
  private fun describe(uri: Uri, intentType: String?): Map<String, Any?> {
    var name: String? = null
    var size: Long = -1
    runCatching {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
        ?.use { c ->
          if (c.moveToFirst()) {
            if (!c.isNull(0)) name = c.getString(0)
            if (!c.isNull(1)) size = c.getLong(1)
          }
        }
    }
    val fileName = name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    val ext = fileName.substringAfterLast('.', "").lowercase()
    val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
      ?: intentType?.takeIf { !it.contains('*') }
      ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
      ?: "application/octet-stream"
    return mapOf("uri" to uri.toString(), "name" to fileName, "mime" to mime, "size" to size.toDouble())
  }
}
