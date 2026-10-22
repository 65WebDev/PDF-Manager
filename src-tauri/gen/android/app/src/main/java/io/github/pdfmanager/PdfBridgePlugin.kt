package io.github.pdfmanager

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
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
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.content.pm.PackageInfoCompat
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
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * The editor's way out to Android (registered from src-tauri/src/android.rs):
 * PDFs sent to the app, the system Save / folder pickers, the share sheet,
 * the print dialog, links, full screen for reading mode, the Back key and
 * the in-app update (a newer APK handed to the system installer).
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
  // The update download, apart from the file work above (it can take a while).
  private val net = Executors.newSingleThreadExecutor()
  @Volatile private var updateDone = 0L
  @Volatile private var updateTotal = -1L
  @Volatile private var updateCancelled = false

  override fun load(webView: WebView) {
    val firstLoad = this.webView == null
    this.webView = webView
    if (!firstLoad) return
    io.execute {
      for (dir in listOf(OPEN_DIR, SHARE_DIR, PRINT_DIR, STAGE_DIR, UPDATE_DIR)) {
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

  // ── In-app update ──────────────────────────────────────────────────────
  // A newer APK from the project's GitHub releases: downloaded into the
  // cache, checked (this app, a newer version, the same signing key) and
  // handed to the system installer, which asks the user once more.

  /**
   * Downloads the APK at `url` and opens the system installer for it;
   * resolves once the installer is up. The first time Android's "Install
   * unknown apps" switch for this app comes up first - the download starts
   * when the user comes back with it on. Rejects with a message that starts
   * with a code the editor tells apart: "install_permission", "cancelled"
   * (cancelUpdate), "not_apk", "not_newer", "other_key".
   */
  @Command
  fun installUpdate(invoke: Invoke) {
    val url = invoke.getArgs().getString("url")
    if (!isReleaseApkUrl(url)) {
      invoke.reject("Обновление скачивается только со страницы релизов проекта")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
      try {
        startActivityForResult(invoke, settings, "onInstallPermission")
      } catch (e: ActivityNotFoundException) {
        invoke.reject("install_permission: разрешите установку приложений для PDF Manager в настройках Android")
      }
      return
    }
    downloadAndInstall(invoke, url)
  }

  @ActivityCallback
  fun onInstallPermission(invoke: Invoke, result: ActivityResult) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      invoke.reject("install_permission: установка приложений для PDF Manager не разрешена")
      return
    }
    downloadAndInstall(invoke, invoke.getArgs().getString("url"))
  }

  /** How far the download is: { done, total } in bytes (total -1 while unknown). */
  @Command
  fun updateProgress(invoke: Invoke) {
    val res = JSObject()
    res.put("done", updateDone)
    res.put("total", updateTotal)
    invoke.resolve(res)
  }

  /** Stops the download; installUpdate then rejects with "cancelled". */
  @Command
  fun cancelUpdate(invoke: Invoke) {
    updateCancelled = true
    invoke.resolve(JSObject())
  }

  private fun isReleaseApkUrl(url: String?): Boolean =
    url != null && url.startsWith(RELEASES_DOWNLOAD) && url.endsWith(".apk") &&
      !url.contains("..") && !url.contains('?') && !url.contains('#')

  private class UpdateRefused(message: String) : Exception(message)

  private fun downloadAndInstall(invoke: Invoke, url: String) {
    updateCancelled = false
    updateDone = 0L
    updateTotal = -1L
    net.execute {
      val dir = File(activity.cacheDir, UPDATE_DIR)
      try {
        dir.deleteRecursively()
        dir.mkdirs()
        val apk = File(dir, "PDF-Manager-update.apk")
        download(url, apk)
        if (updateCancelled) {
          dir.deleteRecursively()
          invoke.reject("cancelled")
          return@execute
        }
        checkUpdateApk(apk)
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
        val install = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.runOnUiThread {
          try {
            activity.startActivity(install)
            invoke.resolve(JSObject())
          } catch (e: Exception) {
            invoke.reject("Не удалось открыть установку: ${e.message ?: e}")
          }
        }
      } catch (e: UpdateRefused) {
        dir.deleteRecursively()
        invoke.reject(e.message ?: "Обновление не подходит")
      } catch (e: Exception) {
        dir.deleteRecursively()
        invoke.reject(if (updateCancelled) "cancelled" else "Не удалось скачать обновление: ${e.message ?: e}")
      }
    }
  }

  /** GET `url` into `to`. */
  private fun download(url: String, to: File) {
    val conn = openFollowingRedirects(url)
    try {
      updateTotal = conn.contentLengthLong
      conn.inputStream.use { input ->
        FileOutputStream(to).use { out ->
          val buf = ByteArray(64 * 1024)
          while (!updateCancelled) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            updateDone += n
          }
        }
      }
    } finally {
      conn.disconnect()
    }
  }

  /** An answered connection to `url`, after up to 5 redirects (https only - GitHub sends release files from its CDN). */
  private fun openFollowingRedirects(url: String): HttpURLConnection {
    var address = url
    repeat(6) {
      val conn = URL(address).openConnection() as HttpURLConnection
      conn.instanceFollowRedirects = false
      conn.connectTimeout = 15000
      conn.readTimeout = 30000
      conn.setRequestProperty("User-Agent", "PDF-Manager-Android")
      val code = conn.responseCode
      if (code == HttpURLConnection.HTTP_OK) return conn
      val next = if (code in 300..399) conn.getHeaderField("Location") else null
      conn.disconnect()
      if (code !in 300..399) throw IOException("HTTP $code")
      if (next == null) throw IOException("перенаправление без адреса")
      address = URL(URL(address), next).toString()
      if (!address.startsWith("https://")) throw IOException("перенаправление не по https")
    }
    throw IOException("слишком много перенаправлений")
  }

  /** The downloaded file must be this app, newer than the one installed, signed with the same key. */
  private fun checkUpdateApk(apk: File) {
    val pm = activity.packageManager
    val archive = archiveInfo(pm, apk.path)
      ?: throw UpdateRefused("not_apk: скачанный файл не является приложением Android")
    if (archive.packageName != activity.packageName) {
      throw UpdateRefused("not_apk: скачанный файл - другое приложение (${archive.packageName})")
    }
    val installed = installedInfo(pm)
    if (PackageInfoCompat.getLongVersionCode(archive) <= PackageInfoCompat.getLongVersionCode(installed)) {
      throw UpdateRefused("not_newer: скачанная версия ${archive.versionName} не новее установленной ${installed.versionName}")
    }
    // Android refuses an update signed with another key ("App not installed");
    // said here in plain words. Where a phone does not report an archive's
    // signer, the installer is left to tell.
    val newKeys = signers(archive)
    val ownKeys = signers(installed)
    if (newKeys != null && ownKeys != null && newKeys.intersect(ownKeys).isEmpty()) {
      throw UpdateRefused("other_key: новая версия подписана другим ключом, чем установленное приложение")
    }
  }

  @Suppress("DEPRECATION")
  private fun archiveInfo(pm: PackageManager, path: String): PackageInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
    }

  @Suppress("DEPRECATION")
  private fun installedInfo(pm: PackageManager): PackageInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
    }

  /** SHA-256 of each signing certificate, or null when the system does not say. */
  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String>? {
    val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signing = info.signingInfo ?: return null
      if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
    } else {
      info.signatures
    }
    if (sigs == null || sigs.isEmpty()) return null
    val sha = MessageDigest.getInstance("SHA-256")
    return sigs.map { sig -> sha.digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
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
    // res/xml/file_paths.xml (share and update folders).
    private const val OPEN_DIR = "pm-open"
    private const val SHARE_DIR = "pm-share"
    private const val PRINT_DIR = "pm-print"
    private const val STAGE_DIR = "pm-stage"
    // The update APK (FileProvider, res/xml/file_paths.xml).
    private const val UPDATE_DIR = "pm-update"
    // The only place an update is downloaded from: the project's releases.
    private const val RELEASES_DOWNLOAD = "https://github.com/65WebDev/PDF-Manager/releases/download/"
  }
}
