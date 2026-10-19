package io.github.pdfmanager

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * The editor's way out to Android (registered from src-tauri/src/android.rs):
 * PDFs sent to the app, the system Save / folder pickers, the share sheet,
 * the print dialog, links, full screen for reading mode and the Back key.
 *
 * Files from the editor arrive as paths in the app cache (put together by
 * the Rust side); files sent to the app are copied into the cache and
 * handed back as paths.
 */
@TauriPlugin
class PdfBridgePlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private val pendingUris = mutableListOf<Uri>()
  // All file work, one job after another and off the UI thread: the cache
  // clean-up at start must finish before the first received file is copied.
  private val io = Executors.newSingleThreadExecutor()
  private var openCounter = 0

  override fun load(webView: WebView) {
    val firstLoad = this.webView == null
    this.webView = webView
    if (!firstLoad) return
    io.execute {
      for (dir in listOf(OPEN_DIR, SHARE_DIR, PRINT_DIR, STAGE_DIR)) {
        File(activity.cacheDir, dir).deleteRecursively()
      }
    }
    // Cold start from "Open with" / "Share": the file is in the launch intent.
    collectUris(activity.intent)
    activity.intent = Intent(Intent.ACTION_MAIN)

    // Back closes what is open in the editor (a dialog, reading mode); with
    // nothing open the app goes to the background instead of closing, so an
    // unsaved document is not lost.
    (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(
      activity,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val view = this@PdfBridgePlugin.webView
          if (view == null) {
            activity.moveTaskToBack(true)
            return
          }
          view.evaluateJavascript(
            "(function(){try{return !!(window.__pmAndroidBack&&window.__pmAndroidBack())}catch(e){return false}})()"
          ) { handled ->
            if (handled != "true") activity.moveTaskToBack(true)
          }
        }
      }
    )
  }

  override fun onNewIntent(intent: Intent) {
    if (collectUris(intent)) {
      webView?.evaluateJavascript(
        "window.__pmAndroidFilesPending&&window.__pmAndroidFilesPending()",
        null
      )
    }
  }

  private fun collectUris(intent: Intent?): Boolean {
    if (intent == null) return false
    val found = mutableListOf<Uri>()
    when (intent.action) {
      Intent.ACTION_VIEW -> intent.data?.let { found.add(it) }
      Intent.ACTION_SEND ->
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { found.add(it) }
      Intent.ACTION_SEND_MULTIPLE ->
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { found.addAll(it) }
    }
    if (found.isEmpty()) return false
    synchronized(pendingUris) { pendingUris.addAll(found) }
    return true
  }

  /** Files sent to the app since the last call, copied into the cache. */
  @Command
  fun takeOpenedFiles(invoke: Invoke) {
    val uris = synchronized(pendingUris) {
      val copy = pendingUris.toList()
      pendingUris.clear()
      copy
    }
    io.execute {
      val paths = JSArray()
      for (uri in uris) {
        try {
          val dir = File(File(activity.cacheDir, OPEN_DIR), (++openCounter).toString())
          dir.mkdirs()
          val file = File(dir, displayName(uri))
          openInput(uri).use { input -> FileOutputStream(file).use { input.copyTo(it) } }
          paths.put(file.absolutePath)
        } catch (e: Exception) {
          android.util.Log.w(TAG, "Could not copy $uri", e)
        }
      }
      invoke.resolve(JSObject().put("paths", paths))
    }
  }

  private fun openInput(uri: Uri): InputStream =
    activity.contentResolver.openInputStream(uri) ?: throw IllegalStateException("No data in $uri")

  /** The name the sender gave the file, made safe for a file name and ending in .pdf. */
  private fun displayName(uri: Uri): String {
    var name: String? = null
    if (uri.scheme == "content") {
      try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
        }
      } catch (_: Exception) {
      }
    }
    if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')
    var safe = (name ?: "").replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim()
    if (safe.isEmpty()) safe = "document"
    if (!safe.lowercase().endsWith(".pdf")) safe += ".pdf"
    return safe
  }

  /** System "Save as": resolves { uri } of the new (empty) document, or {} when backed out. */
  @Command
  fun pickSaveTarget(invoke: Invoke) {
    val args = invoke.getArgs()
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = args.optString("mime", "application/pdf")
      putExtra(Intent.EXTRA_TITLE, args.optString("name", "document.pdf"))
    }
    startActivityForResult(invoke, intent, "onDocumentPicked")
  }

  /** System folder picker: resolves { uri } of the folder, or {} when backed out. */
  @Command
  fun pickFolder(invoke: Invoke) {
    startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "onDocumentPicked")
  }

  @ActivityCallback
  fun onDocumentPicked(invoke: Invoke, result: ActivityResult) {
    val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    val res = JSObject()
    if (uri != null) res.put("uri", uri.toString())
    invoke.resolve(res)
  }

  /** Copies the file at `path` into the document `uri` picked with pickSaveTarget. */
  @Command
  fun writeTarget(invoke: Invoke) {
    val args = invoke.getArgs()
    val uri = Uri.parse(args.getString("uri"))
    val path = args.getString("path")
    io.execute {
      try {
        copyFileTo(path, uri)
        invoke.resolve(JSObject())
      } catch (e: Exception) {
        invoke.reject("Не удалось записать файл: ${e.message ?: e}")
      }
    }
  }

  /** Creates `name` in the folder picked with pickFolder and copies the file at `path` into it. */
  @Command
  fun writeIntoFolder(invoke: Invoke) {
    val args = invoke.getArgs()
    val tree = Uri.parse(args.getString("folder"))
    val name = args.getString("name")
    val mime = args.optString("mime", "application/pdf")
    val path = args.getString("path")
    io.execute {
      try {
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val doc = DocumentsContract.createDocument(activity.contentResolver, parent, mime, name)
          ?: throw IllegalStateException("папка не принимает файлы")
        copyFileTo(path, doc)
        invoke.resolve(JSObject())
      } catch (e: Exception) {
        invoke.reject("Не удалось записать файл: ${e.message ?: e}")
      }
    }
  }

  private fun copyFileTo(path: String, uri: Uri) {
    val resolver = activity.contentResolver
    // "wt" empties a document that already had content; not every storage
    // provider knows it, plain "w" is the fallback.
    val out = try {
      resolver.openOutputStream(uri, "wt")
    } catch (_: Exception) {
      null
    } ?: resolver.openOutputStream(uri, "w") ?: throw IllegalStateException("No output for $uri")
    out.use { o -> FileInputStream(path).use { it.copyTo(o) } }
  }

  /** Removes a document created by pickSaveTarget that was never written. */
  @Command
  fun discardTarget(invoke: Invoke) {
    val uri = Uri.parse(invoke.getArgs().getString("uri"))
    io.execute {
      try {
        DocumentsContract.deleteDocument(activity.contentResolver, uri)
      } catch (_: Exception) {
      }
      invoke.resolve(JSObject())
    }
  }

  /** System share sheet for the file at `path` (in the cache's share folder). */
  @Command
  fun shareFile(invoke: Invoke) {
    val args = invoke.getArgs()
    val file = File(args.getString("path"))
    val mime = args.optString("mime", "application/pdf")
    try {
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri(file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(send, null))
      invoke.resolve(JSObject())
    } catch (e: Exception) {
      invoke.reject("Не удалось поделиться файлом: ${e.message ?: e}")
    }
  }

  /** System print dialog for the PDF at `path`; the file is removed when the job is done. */
  @Command
  fun printFile(invoke: Invoke) {
    val args = invoke.getArgs()
    val file = File(args.getString("path"))
    val jobName = args.optString("name", file.name)
    try {
      val printManager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
      printManager.print(jobName, PdfFilePrintAdapter(file, jobName), null)
      invoke.resolve(JSObject())
    } catch (e: Exception) {
      invoke.reject("Не удалось открыть печать: ${e.message ?: e}")
    }
  }

  private class PdfFilePrintAdapter(private val file: File, private val jobName: String) : PrintDocumentAdapter() {
    override fun onLayout(
      oldAttributes: PrintAttributes?,
      newAttributes: PrintAttributes,
      cancellationSignal: CancellationSignal,
      callback: PrintDocumentAdapter.LayoutResultCallback,
      extras: Bundle?
    ) {
      if (cancellationSignal.isCanceled) {
        callback.onLayoutCancelled()
        return
      }
      val info = PrintDocumentInfo.Builder(jobName)
        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
        .build()
      callback.onLayoutFinished(info, oldAttributes != newAttributes)
    }

    override fun onWrite(
      pages: Array<out PageRange>,
      destination: ParcelFileDescriptor,
      cancellationSignal: CancellationSignal,
      callback: PrintDocumentAdapter.WriteResultCallback
    ) {
      try {
        FileInputStream(file).use { input ->
          FileOutputStream(destination.fileDescriptor).use { input.copyTo(it) }
        }
        if (cancellationSignal.isCanceled) callback.onWriteCancelled()
        else callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
      } catch (e: Exception) {
        callback.onWriteFailed(e.message)
      }
    }

    override fun onFinish() {
      file.parentFile?.deleteRecursively()
    }
  }

  /** Opens a web link in the browser, mailto: in the mail app, tel: in the dialer. */
  @Command
  fun openUrl(invoke: Invoke) {
    val url = invoke.getArgs().getString("url")
    val scheme = Uri.parse(url).scheme?.lowercase()
    if (scheme !in setOf("https", "http", "mailto", "tel")) {
      invoke.reject("Разрешены только ссылки http(s), mailto и tel")
      return
    }
    try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
      invoke.resolve(JSObject())
    } catch (e: ActivityNotFoundException) {
      invoke.reject("Нет приложения для открытия ссылки")
    }
  }

  /** Reading mode: hide the status and navigation bars (a swipe shows them for a moment). */
  @Command
  fun setFullscreen(invoke: Invoke) {
    val on = invoke.getArgs().optBoolean("fullscreen", false)
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      if (on) {
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
      invoke.resolve(JSObject())
    }
  }

  companion object {
    private const val TAG = "PdfBridge"
    // Cache subfolders; the names match src-tauri/src/android.rs and
    // res/xml/file_paths.xml (share folder).
    private const val OPEN_DIR = "pm-open"
    private const val SHARE_DIR = "pm-share"
    private const val PRINT_DIR = "pm-print"
    private const val STAGE_DIR = "pm-stage"
  }
}
