package com.nima.downloads

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

private val GENERIC_TYPES = setOf(
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-download",
  "application/download",
  "application/force-download",
)

private class UnknownDownloadException(id: String) :
  CodedException("No open download '$id'")

private class CreateFailedException(name: String) :
  CodedException("Could not create '$name' in Downloads")

private class NoViewerException(name: String) :
  CodedException("No app can open '$name'")

/**
 * One file being written. Exactly one of [uri] (API 29+, MediaStore) or
 * [file] (older, app-specific storage) is set.
 */
private class Transfer(
  val stream: OutputStream,
  val name: String,
  val uri: Uri? = null,
  val file: File? = null,
)

/**
 * Saves files that the page streams to us. On API 29+ they go into the public
 * Downloads collection through MediaStore, which needs no storage permission;
 * the row stays IS_PENDING (hidden from other apps) until finish() publishes it,
 * so a cancelled download never shows up half-written.
 *
 * Finished files can be remembered under a key (the page passes Telegram's
 * document id), so that tapping the same file again opens it instead of
 * downloading a second copy.
 */
class DownloadsModule : Module() {
  private val transfers = mutableMapOf<String, Transfer>()

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("Downloads")

    AsyncFunction("begin") { id: String, name: String, mime: String ->
      synchronized(transfers) {
        transfers.remove(id)?.let { discard(it) }
        transfers[id] = open(name, mime)
      }
    }

    AsyncFunction("append") { id: String, base64: String ->
      val t = synchronized(transfers) { transfers[id] } ?: throw UnknownDownloadException(id)
      t.stream.write(Base64.decode(base64, Base64.DEFAULT))
    }

    AsyncFunction("finish") { id: String, key: String? ->
      val t = synchronized(transfers) { transfers.remove(id) } ?: throw UnknownDownloadException(id)
      t.stream.close()
      val uri = t.uri
      if (uri == null) {
        // Pre-Android 10 files sit in app-private storage, which other apps
        // can't open without a FileProvider, so they aren't remembered.
        t.file?.name ?: t.name
      } else {
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        context.contentResolver.update(uri, done, null, null)
        if (!key.isNullOrEmpty()) prefs.edit().putString(key, uri.toString()).apply()
        // MediaStore de-duplicates clashing names ("app (1).apk"); report the real one.
        context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
          ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: t.name
      }
    }

    // Keys of remembered files that still exist. Files deleted since (e.g. in
    // the Files app) are forgotten here.
    AsyncFunction("saved") {
      val p = prefs
      val gone = mutableListOf<String>()
      val live = mutableListOf<String>()
      for ((key, value) in p.all) {
        val uri = (value as? String)?.let(Uri::parse)
        if (uri != null && describe(uri) != null) live.add(key) else gone.add(key)
      }
      if (gone.isNotEmpty()) p.edit().apply { gone.forEach { remove(it) } }.apply()
      live
    }

    // Opens a remembered file in whatever app handles its type. False if the
    // file is gone (and forgets it).
    AsyncFunction("open") { key: String ->
      val uri = prefs.getString(key, null)?.let(Uri::parse)
      val info = uri?.let { describe(it) }
      if (uri == null || info == null) {
        prefs.edit().remove(key).apply()
        false
      } else {
        val intent = Intent(Intent.ACTION_VIEW).apply {
          // Files saved before types were fixed up may still say octet-stream.
          setDataAndType(uri, typeFor(info.first, info.second))
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
          (appContext.currentActivity ?: context).startActivity(intent)
        } catch (_: ActivityNotFoundException) {
          throw NoViewerException(info.first)
        }
        true
      }
    }

    AsyncFunction("abort") { id: String ->
      synchronized(transfers) { transfers.remove(id) }?.let { discard(it) }
    }

    OnDestroy {
      synchronized(transfers) {
        transfers.values.forEach { discard(it) }
        transfers.clear()
      }
    }
  }

  private val prefs: SharedPreferences
    get() = context.getSharedPreferences("com.nima.downloads.saved", Context.MODE_PRIVATE)

  /** Name and MIME type of a published MediaStore file, or null if it's gone. */
  private fun describe(uri: Uri): Pair<String, String>? = try {
    context.contentResolver.query(
      uri,
      arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE),
      null,
      null,
      null
    )?.use { c ->
      if (c.moveToFirst()) {
        Pair(c.getString(0) ?: "file", c.getString(1) ?: "application/octet-stream")
      } else {
        null
      }
    }
  } catch (_: Exception) {
    null
  }

  /**
   * The page's MIME type, or the one Android knows for the file's extension
   * when that type is generic. Telegram often only knows "application/
   * octet-stream", and opening a file as that gets Android's "open with" list
   * of unrelated apps instead of, say, the package installer for an .apk.
   */
  private fun typeFor(name: String, mime: String?): String {
    val m = mime?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    if (m.isNotEmpty() && m !in GENERIC_TYPES) return m
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun open(rawName: String, pageMime: String): Transfer {
    // The name comes from the page; keep it a single plain path segment.
    val name = rawName.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().ifEmpty { "download" }
    val mime = typeFor(name, pageMime)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw CreateFailedException(name)
      val stream = resolver.openOutputStream(uri) ?: run {
        resolver.delete(uri, null, null)
        throw CreateFailedException(name)
      }
      return Transfer(stream, name, uri = uri)
    }
    // Pre-Android 10: the public folder would need WRITE_EXTERNAL_STORAGE, so
    // fall back to the app's own Downloads directory.
    val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
    dir.mkdirs()
    var file = File(dir, name)
    var n = 1
    val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
    while (file.exists()) {
      file = File(dir, name.substring(0, dot) + " (" + n++ + ")" + name.substring(dot))
    }
    return Transfer(FileOutputStream(file), name, file = file)
  }

  private fun discard(t: Transfer) {
    try {
      t.stream.close()
    } catch (_: Exception) {}
    try {
      t.uri?.let { context.contentResolver.delete(it, null, null) }
      t.file?.delete()
    } catch (_: Exception) {}
  }
}
