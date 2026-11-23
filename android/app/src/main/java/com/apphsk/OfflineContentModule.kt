package com.apphsk

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Files stay in the app's private persistent directory, never the evictable cache. */
class OfflineContentModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newFixedThreadPool(3)
  private val root = File(context.filesDir, "offline-learning-v1")
  private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = publishConnection()
    override fun onLost(network: Network) = publishConnection()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = publishConnection()
  }
  override fun getName() = "OfflineContent"
  override fun initialize() {
    super.initialize()
    connectivity.registerDefaultNetworkCallback(callback)
  }
  override fun invalidate() {
    try { connectivity.unregisterNetworkCallback(callback) } catch (_: Exception) { }
    executor.shutdownNow()
    super.invalidate()
  }
  private fun connected(): Boolean {
    val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  }
  private fun publishConnection() {
    if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("hskOfflineConnection", connected())
  }
  @ReactMethod fun addListener(name: String) { }
  @ReactMethod fun removeListeners(count: Double) { }
  @ReactMethod fun isConnected(promise: Promise) { promise.resolve(connected()) }
  @ReactMethod fun isUnmetered(promise: Promise) {
    val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
    promise.resolve(caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true && connected())
  }
  private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    .joinToString("") { "%02x".format(it) }
  private fun directory(scope: String): File {
    val dir = File(root, hash(scope)).canonicalFile
    require(dir.parentFile == root.canonicalFile) { "Invalid download directory" }
    return dir
  }
  @ReactMethod fun download(scope: String, rawUrl: String, token: String, promise: Promise) {
    executor.execute {
      var connection: HttpURLConnection? = null
      var partial: File? = null
      try {
        val initial = URL(rawUrl)
        require(initial.protocol in listOf("http", "https")) { "Unsupported URL" }
        val dir = directory(scope)
        check(dir.mkdirs() || dir.isDirectory) { "Cannot create download directory" }
        check(dir.usableSpace > 25L * 1024 * 1024) { "Bộ nhớ trống không đủ để tải nội dung." }
        var target = initial
        var redirects = 0
        while (true) {
          val current = target.openConnection() as HttpURLConnection
          connection = current
          current.connectTimeout = 15000
          current.readTimeout = 30000
          current.instanceFollowRedirects = false
          current.setRequestProperty("Accept-Encoding", "identity")
          // Never forward the account token to a CDN reached through a redirect.
          if (token.isNotEmpty() && target.protocol == initial.protocol && target.host == initial.host && target.port == initial.port)
            current.setRequestProperty("Authorization", "Bearer $token")
          val status = current.responseCode
          if (status in listOf(301, 302, 303, 307, 308)) {
            check(redirects++ < 5) { "Too many redirects" }
            val next = URL(target, current.getHeaderField("Location") ?: error("Missing redirect"))
            require(next.protocol in listOf("http", "https") && !(target.protocol == "https" && next.protocol == "http")) { "Unsafe redirect" }
            current.disconnect()
            target = next
          } else {
            check(status == 200) { "Không tải được tệp ($status). Vui lòng kiểm tra nội dung trên máy chủ." }
            break
          }
        }
        val current = connection!!
        val type = current.contentType.orEmpty().lowercase()
        check(!type.contains("text/html") && !type.contains("application/json")) { "Máy chủ trả về nội dung không phải ảnh/audio." }
        val expected = current.contentLengthLong
        val maximum = 64L * 1024 * 1024
        check(expected <= maximum) { "Tệp quá lớn (tối đa 64 MB)." }
        val ext = when {
          type.contains("png") -> ".png"
          type.contains("webp") -> ".webp"
          type.contains("jpeg") -> ".jpg"
          type.contains("wav") -> ".wav"
          type.contains("mp4") -> ".m4a"
          type.startsWith("audio/") -> ".mp3"
          else -> initial.path.substringAfterLast('.', "bin").takeIf { it.matches(Regex("[a-zA-Z0-9]{1,5}")) }?.let { ".$it" } ?: ".bin"
        }
        val file = File(dir, hash(rawUrl) + ext)
        val temporary = File(dir, file.name + ".part")
        partial = temporary
        var bytes = 0L
        current.inputStream.use { input ->
          temporary.outputStream().use { output ->
            val buffer = ByteArray(32768)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              bytes += count
              check(bytes <= maximum && !Thread.currentThread().isInterrupted) { "Download cancelled or file too large" }
              output.write(buffer, 0, count)
            }
          }
        }
        check(bytes > 0 && (expected < 0 || bytes == expected)) { "Tệp tải về chưa đầy đủ." }
        check(temporary.renameTo(file)) { "Cannot publish downloaded file" }
        val result = Arguments.createMap()
        result.putString("uri", Uri.fromFile(file).toString())
        result.putDouble("bytes", bytes.toDouble())
        promise.resolve(result)
      } catch (error: Exception) {
        partial?.delete()
        promise.reject("OFFLINE_DOWNLOAD", error.message ?: "Không thể tải nội dung.")
      } finally { connection?.disconnect() }
    }
  }
  @ReactMethod fun validateFiles(uris: ReadableArray, promise: Promise) {
    executor.execute {
      try {
        val valid = (0 until uris.size()).all { index ->
          val file = File(Uri.parse(uris.getString(index)).path ?: "").canonicalFile
          file.path.startsWith(root.canonicalPath + File.separator) && file.isFile && file.length() > 0
        }
        promise.resolve(valid)
      } catch (error: Exception) { promise.reject("OFFLINE_FILES", error) }
    }
  }
  @ReactMethod fun removePack(scope: String, promise: Promise) {
    executor.execute {
      try {
        val dir = directory(scope)
        check(!dir.exists() || dir.deleteRecursively()) { "Cannot remove offline package" }
        promise.resolve(null)
      } catch (error: Exception) { promise.reject("OFFLINE_DELETE", error) }
    }
  }
}
