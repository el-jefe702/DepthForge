package com.depthforge.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

object ApiClient {
    var baseUrl = "http://4.3.2.122:8000/"

    private fun apiUrl(path: String): String {
        return baseUrl.trim().removeSuffix("/") + path
    }

    // POST JSON, return parsed JSONObject
    private suspend fun postJson(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val conn = URL(apiUrl(path)).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        conn.connectTimeout = 60000
        conn.readTimeout = 120000
        OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
        val responseCode = conn.responseCode
        val stream = if (responseCode in 200..299) conn.inputStream else conn.errorStream
        val responseText = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = try {
            JSONObject(responseText)
        } catch (e: Exception) {
            JSONObject().put("error", "HTTP $responseCode: $responseText")
        }
        if (responseCode == 429) {
            val currentErr = json.optString("error", "")
            if (currentErr.isEmpty() || currentErr.startsWith("HTTP 429")) {
                json.put("error", "Too many requests. Please wait before generating again.")
            }
        }
        if (!json.has("statusCode")) {
            json.put("statusCode", responseCode)
        }
        json
    }

    // POST multipart file — uses OkHttp to correctly handle binary data
    private suspend fun postMultipart(
        path: String,
        file: File,
        fieldName: String,
        extraParams: Map<String, String> = emptyMap()
    ): JSONObject = withContext(Dispatchers.IO) {
        val client = OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .build()

        val mimeType = "image/*".toMediaTypeOrNull() ?: "application/octet-stream".toMediaTypeOrNull()!!
        val builder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(fieldName, file.name, file.asRequestBody(mimeType))

        for ((key, value) in extraParams) {
            builder.addFormDataPart(key, value)
        }

        val requestBody = builder.build()

        val request = Request.Builder()
            .url(apiUrl(path))
            .post(requestBody)
            .build()

        val response = client.newCall(request).execute()
        val statusCode = response.code
        val responseText = response.body?.string() ?: "{}"
        val json = try {
            JSONObject(responseText)
        } catch (e: Exception) {
            JSONObject().put("error", "HTTP $statusCode: ${response.message}")
        }
        if (statusCode == 429) {
            val currentErr = json.optString("error", "")
            if (currentErr.isEmpty() || currentErr.startsWith("HTTP 429")) {
                json.put("error", "Too many requests. Please wait before generating again.")
            }
        }
        if (!json.has("statusCode")) {
            json.put("statusCode", statusCode)
        }
        json
    }

    // Check if a response indicates rate limiting (HTTP 429)
    fun isRateLimited(response: JSONObject): Boolean {
        return response.optInt("statusCode") == 429 ||
               response.optString("error").contains("Too many requests", ignoreCase = true)
    }

    // Download image as Bitmap
    suspend fun downloadImage(urlPath: String): Bitmap? = withContext(Dispatchers.IO) {
        try {
            val fullUrl = if (urlPath.startsWith("http")) urlPath
                          else apiUrl(urlPath)
            val stream = URL(fullUrl).openStream()
            BitmapFactory.decodeStream(stream)
        } catch (e: Exception) { null }
    }

    // Generate depth map from text prompt with aspect ratio (F1 legacy overload)
    suspend fun generate(prompt: String, aspectRatio: String = "1:1"): JSONObject {
        return generate(prompt, aspectRatio, 70, null)
    }

    // Generate depth map from text prompt with aspect ratio and depth intensity (F6 overload)
    suspend fun generate(prompt: String, aspectRatio: String, depthIntensity: Int = 70): JSONObject {
        return generate(prompt, aspectRatio, depthIntensity, null)
    }

    // Generate depth map from text prompt with aspect ratio, depth intensity, optional style preset, and optional batch (F13)
    suspend fun generate(
        prompt: String,
        aspectRatio: String = "1:1",
        depthIntensity: Int = 70,
        stylePreset: String? = null,
        batch: Boolean = false
    ): JSONObject {
        val body = JSONObject().apply {
            put("prompt", prompt)
            put("aspectRatio", aspectRatio)
            put("depth_intensity", depthIntensity)
            put("depthIntensity", depthIntensity)
            if (!stylePreset.isNullOrBlank()) {
                put("style_preset", stylePreset)
                put("stylePreset", stylePreset)
            }
            if (batch) {
                put("batch", true)
                put("numberOfImages", 4)
            }
        }
        return postJson("/api/generate", body)
    }

    // Post-process (polish/smooth) an image
    suspend fun postprocess(imageUrl: String): JSONObject {
        return postJson("/api/postprocess", JSONObject().put("image_url", imageUrl))
    }

    // Post-process with real-time SSE progress streaming
    suspend fun postprocessStream(
        imageUrl: String,
        onProgress: (step: Int, message: String) -> Unit = { _, _ -> }
    ): JSONObject = withContext(Dispatchers.IO) {
        val client = OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .build()

        val encodedUrl = java.net.URLEncoder.encode(imageUrl, "UTF-8")
        val request = Request.Builder()
            .url(apiUrl("/api/postprocess-stream?image_url=$encodedUrl"))
            .header("Accept", "text/event-stream")
            .build()

        var resultJson = JSONObject()
        val response = client.newCall(request).execute()
        response.use { resp ->
            if (!resp.isSuccessful) {
                val errorBody = resp.body?.string() ?: ""
                return@withContext try {
                    JSONObject(errorBody)
                } catch (e: Exception) {
                    JSONObject().put("error", "HTTP ${resp.code}: ${resp.message}")
                }
            }
            resp.body?.byteStream()?.bufferedReader()?.use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val currentLine = line ?: continue
                    if (currentLine.startsWith("data:")) {
                        val dataStr = currentLine.removePrefix("data:").trim()
                        if (dataStr.isNotEmpty()) {
                            try {
                                val json = JSONObject(dataStr)
                                if (json.has("step")) {
                                    val step = json.optInt("step", 1)
                                    val msg = json.optString("message", "")
                                    withContext(Dispatchers.Main) {
                                        onProgress(step, msg)
                                    }
                                }
                                if (json.optString("status") == "complete" || json.has("image_url") || json.has("error")) {
                                    resultJson = json
                                }
                            } catch (e: Exception) {
                                // ignore malformed line
                            }
                        }
                    }
                }
            }
        }
        resultJson
    }

    // Remove background
    suspend fun removeBg(imageUrl: String): JSONObject {
        return postJson("/api/remove_bg", JSONObject().put("image_url", imageUrl))
    }

    // Invert depth map
    suspend fun invert(imageUrl: String): JSONObject {
        return postJson("/api/invert", JSONObject().put("image_url", imageUrl))
    }

    // Convert photo to depth map with aspect ratio (F1 legacy overload)
    suspend fun photoToDepth(file: File, aspectRatio: String = "1:1"): JSONObject {
        return photoToDepth(file, aspectRatio, 70) // mapOf("aspectRatio" to aspectRatio)
    }

    // Convert photo to depth map with aspect ratio and depth intensity (F6 overload)
    suspend fun photoToDepth(file: File, aspectRatio: String, depthIntensity: Int = 70): JSONObject {
        return photoToDepth(file, aspectRatio, depthIntensity, null)
    }

    // Convert photo to depth map with aspect ratio, depth intensity, optional style preset, and optional batch (F13)
    suspend fun photoToDepth(
        file: File,
        aspectRatio: String = "1:1",
        depthIntensity: Int = 70,
        stylePreset: String? = null,
        batch: Boolean = false
    ): JSONObject {
        val params = mutableMapOf(
            "aspectRatio" to aspectRatio,
            "depth_intensity" to depthIntensity.toString(),
            "depthIntensity" to depthIntensity.toString()
        )
        if (!stylePreset.isNullOrBlank()) {
            params["style_preset"] = stylePreset
            params["stylePreset"] = stylePreset
        }
        if (batch) {
            params["batch"] = "true"
            params["numberOfImages"] = "4"
        }
        return postMultipart("/api/photo-to-depth", file, "photo", params)
    }

    // Check server health via GET /api/health
    suspend fun checkHealth(): JSONObject = withContext(Dispatchers.IO) {
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build()

        try {
            val request = Request.Builder()
                .url(apiUrl("/api/health"))
                .get()
                .build()

            val response = client.newCall(request).execute()
            response.use { resp ->
                val statusCode = resp.code
                val isSuccess = resp.isSuccessful
                val responseText = resp.body?.string() ?: "{}"
                val json = try {
                    JSONObject(responseText)
                } catch (e: Exception) {
                    JSONObject().apply {
                        put("rawResponse", responseText)
                        put("error", "Non-JSON response from server (HTTP $statusCode)")
                    }
                }
                json.put("isHealthy", isSuccess && json.optString("status") == "ok")
                json.put("statusCode", statusCode)
                json
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("status", "error")
                put("error", e.message ?: "Unknown error")
                put("isHealthy", false)
                put("statusCode", 0)
            }
        }
    }

    // Convenience method returning boolean
    suspend fun isHealthy(): Boolean {
        return try {
            val res = checkHealth()
            res.optBoolean("isHealthy", false)
        } catch (e: Exception) {
            false
        }
    }
}
