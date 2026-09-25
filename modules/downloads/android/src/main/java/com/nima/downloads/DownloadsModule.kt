package com.nima.downloads

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

private class UnknownDownloadException(id: String) :
  CodedException("No open download '$id'")

private class CreateFailedException(name: String) :
  CodedException("Could not create '$name' in Downloads")

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

    AsyncFunction("finish") { id: String ->
      val t = synchronized(transfers) { transfers.remove(id) } ?: throw UnknownDownloadException(id)
      t.stream.close()
      val uri = t.uri
      if (uri == null) {
        t.file?.name ?: t.name
      } else {
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        context.contentResolver.update(uri, done, null, null)
        // MediaStore de-duplicates clashing names ("app (1).apk"); report the real one.
        context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
          ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: t.name
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

  private fun open(rawName: String, mime: String): Transfer {
    // The name comes from the page; keep it a single plain path segment.
    val name = rawName.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().ifEmpty { "download" }
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
