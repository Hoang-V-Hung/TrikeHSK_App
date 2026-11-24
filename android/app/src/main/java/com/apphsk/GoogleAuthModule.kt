package com.apphsk

import android.content.MutableContextWrapper
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.NoCredentialException
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/** Opens Google's account picker. Only the backend may accept the returned ID token as a login. */
class GoogleAuthModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var pending: Promise? = null
  private var cancellation: CancellationSignal? = null
  override fun getName() = "GoogleAuth"

  private fun reject(promise: Promise, code: String, message: String) {
    if (pending !== promise) return
    pending = null
    cancellation = null
    promise.reject(code, message)
  }

  @ReactMethod fun signIn(webClientId: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      if (pending != null) {
        promise.reject("IN_PROGRESS", "Đăng nhập Google đang được thực hiện.")
        return@runOnUiThread
      }
      val activity = context.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed) {
        promise.reject("NO_ACTIVITY", "Hãy mở lại màn hình đăng nhập rồi thử Google.")
        return@runOnUiThread
      }
      if (!webClientId.endsWith(".apps.googleusercontent.com")) {
        promise.reject("CONFIGURATION", "Chưa cấu hình Google Client ID cho ứng dụng.")
        return@runOnUiThread
      }
      pending = promise
      val signal = CancellationSignal()
      cancellation = signal
      try {
        val option = GetSignInWithGoogleOption.Builder(webClientId).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        CredentialManager.create(activity).getCredentialAsync(
          MutableContextWrapper(activity), request, signal, ContextCompat.getMainExecutor(activity),
          object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
            override fun onResult(result: GetCredentialResponse) {
              if (pending !== promise) return
              try {
                val credential = result.credential
                if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                  reject(promise, "INVALID_CREDENTIAL", "Google chưa trả thông tin đăng nhập hợp lệ. Vui lòng thử lại.")
                  return
                }
                val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
                if (token.isBlank()) {
                  reject(promise, "INVALID_CREDENTIAL", "Google chưa trả thông tin đăng nhập. Vui lòng thử lại.")
                  return
                }
                pending = null
                cancellation = null
                promise.resolve(token)
              } catch (_: Exception) {
                reject(promise, "INVALID_CREDENTIAL", "Không đọc được thông tin từ Google. Vui lòng thử lại.")
              }
            }
            override fun onError(error: GetCredentialException) {
              when (error) {
                is GetCredentialCancellationException -> reject(promise, "CANCELLED", "Đã hủy đăng nhập Google.")
                is NoCredentialException -> reject(promise, "NO_CREDENTIAL", "Chưa tìm được tài khoản Google. Hãy thêm tài khoản Google vào điện thoại và kiểm tra lại cấu hình Android trên Google Cloud.")
                is GetCredentialProviderConfigurationException -> reject(promise, "PLAY_SERVICES", "Hãy cập nhật Google Play services trên điện thoại rồi thử lại.")
                else -> reject(promise, "GOOGLE_SIGN_IN_FAILED", "Không kết nối được đăng nhập Google. Hãy kiểm tra mạng và cấu hình Android trên Google Cloud.")
              }
            }
          },
        )
      } catch (_: Exception) {
        reject(promise, "GOOGLE_SIGN_IN_FAILED", "Không mở được đăng nhập Google. Hãy cập nhật Google Play services rồi thử lại.")
      }
    }
  }

  @ReactMethod fun cancelSignIn() {
    UiThreadUtil.runOnUiThread {
      val promise = pending
      val signal = cancellation
      if (promise != null) reject(promise, "CANCELLED", "Đã hủy đăng nhập Google.")
      signal?.cancel()
    }
  }

  @ReactMethod fun signOut(promise: Promise) {
    try {
      CredentialManager.create(context).clearCredentialStateAsync(
      ClearCredentialStateRequest(), null, ContextCompat.getMainExecutor(context),
      object : CredentialManagerCallback<Void?, ClearCredentialException> {
        override fun onResult(result: Void?) { promise.resolve(null) }
        override fun onError(error: ClearCredentialException) { promise.resolve(null) }
      },
      )
    } catch (_: Exception) { promise.resolve(null) }
  }

  override fun invalidate() {
    cancelSignIn()
    super.invalidate()
  }
}
