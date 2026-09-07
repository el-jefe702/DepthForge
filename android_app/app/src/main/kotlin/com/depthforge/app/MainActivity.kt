package com.depthforge.app

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

val DarkBackground = Color(0xFF0A0A0F)
val CardBackground = Color(0xFF14141C)
val TextPrimary = Color(0xFFE8E8F0)
val TextSecondary = Color(0xFF8888A0)
val GoldAccent = Color(0xFFD4AF37)
val IndigoAccent = Color(0xFF6366F1)
val EmeraldAccent = Color(0xFF10B981)
val PinkAccent = Color(0xFFEC4899)
val OrangeAccent = Color(0xFFFF6B35)
val CyanAccent = Color(0xFF0891B2)
val PurpleAccent = Color(0xFF8B5CF6)
val GrayBorder = Color(0xFF2A2A3A)

@Composable
fun DepthForgeTheme(content: @Composable () -> Unit) {
    val colors = darkColors(
        primary = GoldAccent,
        primaryVariant = IndigoAccent,
        secondary = IndigoAccent,
        background = DarkBackground,
        surface = CardBackground,
        onPrimary = DarkBackground,
        onSecondary = TextPrimary,
        onBackground = TextPrimary,
        onSurface = TextPrimary,
    )
    MaterialTheme(
        colors = colors,
        content = content
    )
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("depthforge_prefs", Context.MODE_PRIVATE)
        ApiClient.baseUrl = prefs.getString("server_url", "http://4.3.2.122:8000/") ?: "http://4.3.2.122:8000/"
        setContent {
            DepthForgeTheme {
                ForgeApp(prefs)
            }
        }
    }
}

object PromptHistoryManager {
    const val PREFS_KEY = "depthforge_prompt_history"
    const val MAX_ITEMS = 10
    private val gson = Gson()
    private val listType = object : TypeToken<List<String?>>() {}.type

    fun getHistory(prefs: SharedPreferences): List<String> {
        val jsonStr = prefs.getString(PREFS_KEY, null) ?: return emptyList()
        return try {
            val list: List<String?>? = gson.fromJson(jsonStr, listType)
            list?.filterNotNull()?.map { it.trim() }?.filter { it.isNotBlank() } ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun savePrompt(prefs: SharedPreferences, prompt: String?): List<String> {
        val trimmed = prompt?.trim() ?: ""
        if (trimmed.isBlank()) return getHistory(prefs)
        val current = getHistory(prefs).toMutableList()
        current.removeAll { it == trimmed }
        current.add(0, trimmed)
        val capped = if (current.size > MAX_ITEMS) current.subList(0, MAX_ITEMS) else current
        val jsonStr = gson.toJson(capped)
        prefs.edit().putString(PREFS_KEY, jsonStr).apply()
        return capped
    }

    fun clearHistory(prefs: SharedPreferences) {
        prefs.edit().remove(PREFS_KEY).apply()
    }
}

data class SessionGalleryItem(
    val id: String,
    val imageUrl: String,
    val bitmap: Bitmap? = null,
    val label: String = "Image",
    val timestamp: String = ""
)

object SessionGalleryManager {
    fun addItem(
        currentList: List<SessionGalleryItem>,
        imageUrl: String,
        bitmap: Bitmap? = null,
        label: String = "Image",
        timestamp: String? = null
    ): Pair<List<SessionGalleryItem>, SessionGalleryItem> {
        val time = timestamp ?: run {
            val format = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
            format.format(java.util.Date())
        }
        val id = "gallery_${System.currentTimeMillis()}_${currentList.size}"
        val item = SessionGalleryItem(
            id = id,
            imageUrl = imageUrl,
            bitmap = bitmap,
            label = label,
            timestamp = time
        )
        return Pair(currentList + item, item)
    }

    fun clear(): List<SessionGalleryItem> = emptyList()

    fun findItem(list: List<SessionGalleryItem>, id: String): SessionGalleryItem? {
        return list.find { it.id == id }
    }
}

@Composable
fun ForgeApp(prefs: SharedPreferences) {
    var showSettings by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(DarkBackground)) {
        ForgeScreen(prefs = prefs, onOpenSettings = { showSettings = true })

        if (showSettings) {
            var serverUrlInput by remember { mutableStateOf(ApiClient.baseUrl) }
            Dialog(onDismissRequest = { showSettings = false }) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = CardBackground,
                    modifier = Modifier.padding(16.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("Settings", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = TextPrimary)
                        Spacer(modifier = Modifier.height(16.dp))
                        OutlinedTextField(
                            value = serverUrlInput,
                            onValueChange = { serverUrlInput = it },
                            label = { Text("Server URL", color = TextSecondary) },
                            colors = TextFieldDefaults.outlinedTextFieldColors(
                                textColor = TextPrimary,
                                cursorColor = GoldAccent,
                                focusedBorderColor = GoldAccent,
                                unfocusedBorderColor = GrayBorder
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Row(
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            TextButton(onClick = { showSettings = false }) {
                                Text("Cancel", color = TextSecondary)
                            }
                            Button(
                                onClick = {
                                    ApiClient.baseUrl = serverUrlInput
                                    prefs.edit().putString("server_url", serverUrlInput).apply()
                                    showSettings = false
                                },
                                colors = ButtonDefaults.buttonColors(backgroundColor = GoldAccent)
                            ) {
                                Text("Save")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AspectRatioSelector(
    selectedRatio: String,
    onRatioSelected: (String) -> Unit
) {
    val ratios = listOf("1:1", "4:3", "3:2", "16:9", "2:3")
    Column(modifier = Modifier.fillMaxWidth()) {
        Text("Aspect Ratio", color = TextSecondary, fontSize = 14.sp)
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            ratios.forEach { ratio ->
                val isSelected = ratio == selectedRatio
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isSelected) GoldAccent else CardBackground)
                        .border(1.dp, if (isSelected) GoldAccent else GrayBorder, RoundedCornerShape(8.dp))
                        .clickable { onRatioSelected(ratio) }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = ratio,
                        color = if (isSelected) DarkBackground else TextPrimary,
                        fontSize = 12.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                    )
                }
            }
        }
    }
@Composable
fun StylePresetSelector(
    selectedPreset: String?,
    onPresetSelected: (String?) -> Unit,
    enabled: Boolean = true
) {
    val presets = listOf(
        "portrait" to "👤 Portrait",
        "wildlife" to "🦁 Wildlife",
        "ornamental" to "⚜️ Ornamental",
        "floral" to "🌸 Floral",
        "architecture" to "🏛️ Architecture",
        "abstract" to "🌀 Abstract"
    )

    Column(modifier = Modifier.fillMaxWidth()) {
        Text("Style Preset (Optional)", color = TextSecondary, fontSize = 14.sp)
        Spacer(modifier = Modifier.height(8.dp))
        LazyRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(presets) { (id, label) ->
                val isSelected = id == selectedPreset
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(if (isSelected) GoldAccent else CardBackground)
                        .border(1.dp, if (isSelected) GoldAccent else GrayBorder, RoundedCornerShape(20.dp))
                        .clickable(enabled = enabled) {
                            if (isSelected) onPresetSelected(null)
                            else onPresetSelected(id)
                        }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label,
                        color = if (isSelected) DarkBackground else TextPrimary,
                        fontSize = 12.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                    )
                }
            }
        }
    }
}

@Composable
fun DepthIntensitySlider(
    intensity: Float,
    onIntensityChange: (Float) -> Unit,
    enabled: Boolean = true
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text("Depth Intensity: ${intensity.toInt()}%", color = TextSecondary, fontSize = 14.sp)
        Spacer(modifier = Modifier.height(4.dp))
        Slider(
            value = intensity,
            onValueChange = onIntensityChange,
            valueRange = 0f..100f,
            enabled = enabled,
            colors = SliderDefaults.colors(
                thumbColor = GoldAccent,
                activeTrackColor = GoldAccent,
                inactiveTrackColor = GrayBorder
            ),
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
fun ForgeScreen(prefs: SharedPreferences? = null, onOpenSettings: () -> Unit) {
    val context = LocalContext.current
    val actualPrefs = prefs ?: context.getSharedPreferences("depthforge_prefs", Context.MODE_PRIVATE)
    var promptHistory by remember { mutableStateOf(PromptHistoryManager.getHistory(actualPrefs)) }

    var promptInput by remember { mutableStateOf("") }
    var inputMode by remember { mutableStateOf("text") }
    var selectedAspectRatio by remember { mutableStateOf("1:1") }
    var depthIntensity by remember { mutableStateOf(70f) }
    var selectedPhotoUri by remember { mutableStateOf<Uri?>(null) }
    var currentImageUrl by remember { mutableStateOf("") }
    var currentBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var beforeImageUrl by remember { mutableStateOf<String?>(null) }
    var beforeBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var afterImageUrl by remember { mutableStateOf<String?>(null) }
    var isComparing by remember { mutableStateOf(false) }
    var comparisonSplit by remember { mutableStateOf(0.5f) }
    var sessionGallery by remember { mutableStateOf<List<SessionGalleryItem>>(emptyList()) }
    var activeGalleryItemId by remember { mutableStateOf<String?>(null) }
    var isGalleryVisible by remember { mutableStateOf(true) }
    val galleryListState = rememberLazyListState()
    
    var isGenerating by remember { mutableStateOf(false) }
    var isPolishing by remember { mutableStateOf(false) }
    var isPolished by remember { mutableStateOf(false) }
    var isRemovingBg by remember { mutableStateOf(false) }
    var bgRemoved by remember { mutableStateOf(false) }
    var isInverting by remember { mutableStateOf(false) }
    var selectedStylePreset by remember { mutableStateOf<String?>(null) }
    var show3DWebView by remember { mutableStateOf(false) }
    var lastError by remember { mutableStateOf<String?>(null) }
    var activePolishStep by remember { mutableStateOf(-1) }
    
    val isBusy = isGenerating || isPolishing || isInverting || isRemovingBg

    val coroutineScope = rememberCoroutineScope()
    val scaffoldState = rememberScaffoldState()

    BackHandler(enabled = isComparing) {
        isComparing = false
    }

    LaunchedEffect(activeGalleryItemId) {
        if (activeGalleryItemId != null) {
            val index = sessionGallery.indexOfFirst { it.id == activeGalleryItemId }
            if (index >= 0) {
                galleryListState.animateScrollToItem(index)
            }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        selectedPhotoUri = uri
    }

    Scaffold(
        scaffoldState = scaffoldState,
        backgroundColor = DarkBackground
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "DepthForge",
                    color = TextPrimary,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Serif
                )
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = TextPrimary)
                }
            }
            Divider(color = GrayBorder, modifier = Modifier.padding(vertical = 16.dp))

            // Input Card
            Card(
                backgroundColor = CardBackground,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, GrayBorder),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Carve Parameters", color = TextPrimary, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Serif, fontSize = 18.sp)
                    Spacer(modifier = Modifier.height(16.dp))
                    
                    Row(modifier = Modifier.fillMaxWidth()) {
                        Button(
                            onClick = { inputMode = "text" },
                            colors = ButtonDefaults.buttonColors(
                                backgroundColor = if (inputMode == "text") GoldAccent else CardBackground
                            ),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Text Prompt", color = if (inputMode == "text") DarkBackground else TextPrimary)
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = { inputMode = "photo" },
                            colors = ButtonDefaults.buttonColors(
                                backgroundColor = if (inputMode == "photo") GoldAccent else CardBackground
                            ),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Upload Photo", color = if (inputMode == "photo") DarkBackground else TextPrimary)
                        }
                    }
                    Spacer(modifier = Modifier.height(16.dp))

                    if (inputMode == "text") {
                        Text("What do you want to carve?", color = TextSecondary, fontSize = 14.sp)
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = promptInput,
                            onValueChange = { promptInput = it },
                            modifier = Modifier.fillMaxWidth().height(100.dp),
                            colors = TextFieldDefaults.outlinedTextFieldColors(
                                textColor = TextPrimary,
                                unfocusedBorderColor = GrayBorder,
                                focusedBorderColor = GoldAccent
                            )
                        )

                        if (promptHistory.isNotEmpty()) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "Recent Prompts (${promptHistory.size})",
                                        color = TextSecondary,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    TextButton(
                                        onClick = {
                                            PromptHistoryManager.clearHistory(actualPrefs)
                                            promptHistory = emptyList()
                                        },
                                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                                        modifier = Modifier.height(28.dp),
                                        enabled = !isBusy
                                    ) {
                                        Text("Clear history", color = if (!isBusy) PinkAccent else TextSecondary, fontSize = 12.sp)
                                    }
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Column(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalArrangement = Arrangement.spacedBy(4.dp)
                                ) {
                                    promptHistory.forEach { histPrompt ->
                                        Box(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clip(RoundedCornerShape(6.dp))
                                                .background(Color(0xFF0D0D15))
                                                .border(1.dp, GrayBorder, RoundedCornerShape(6.dp))
                                                .clickable(enabled = !isBusy) {
                                                    promptInput = histPrompt
                                                }
                                                .padding(horizontal = 10.dp, vertical = 8.dp)
                                        ) {
                                            Text(
                                                text = histPrompt,
                                                color = TextPrimary,
                                                fontSize = 12.sp,
                                                maxLines = 1,
                                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))
                        StylePresetSelector(
                            selectedPreset = selectedStylePreset,
                            onPresetSelected = { selectedStylePreset = it },
                            enabled = !isBusy
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        AspectRatioSelector(
                            selectedRatio = selectedAspectRatio,
                            onRatioSelected = { selectedAspectRatio = it }
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        DepthIntensitySlider(
                            intensity = depthIntensity,
                            onIntensityChange = { depthIntensity = it },
                            enabled = !isBusy
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(
                            onClick = {
                                if (promptInput.isNotBlank() && !isBusy) {
                                    isGenerating = true
                                    lastError = null
                                    currentImageUrl = ""
                                    currentBitmap = null
                                    beforeImageUrl = null
                                    beforeBitmap = null
                                    afterImageUrl = null
                                    isComparing = false
                                    isPolished = false
                                    bgRemoved = false
                                    
                                    coroutineScope.launch {
                                        try {
                                            val res = ApiClient.generate(
                                                prompt = promptInput,
                                                aspectRatio = selectedAspectRatio,
                                                depthIntensity = depthIntensity.toInt(),
                                                stylePreset = selectedStylePreset
                                            ) // ApiClient.generate(promptInput, selectedAspectRatio, depthIntensity.toInt()) ApiClient.generate(promptInput, selectedAspectRatio)
                                            if (res.optString("status") == "success") {
                                                currentImageUrl = res.getString("image_url")
                                                currentBitmap = ApiClient.downloadImage(currentImageUrl)
                                                promptHistory = PromptHistoryManager.savePrompt(actualPrefs, promptInput)
                                                val (updatedGallery, newItem) = SessionGalleryManager.addItem(
                                                    sessionGallery,
                                                    currentImageUrl,
                                                    currentBitmap,
                                                    "Generated"
                                                )
                                                sessionGallery = updatedGallery
                                                activeGalleryItemId = newItem.id
                                            } else {
                                                val errorMsg = if (ApiClient.isRateLimited(res)) {
                                                    val serverError = res.optString("error")
                                                    if (serverError.isBlank() || serverError.startsWith("HTTP 429")) {
                                                        "Too many requests. Please wait before generating again."
                                                    } else {
                                                        serverError
                                                    }
                                                } else {
                                                    res.optString("error").ifEmpty { "Generation failed" }
                                                }
                                                lastError = errorMsg
                                                coroutineScope.launch {
                                                    scaffoldState.snackbarHostState.showSnackbar(errorMsg)
                                                }
                                            }
                                        } catch (e: Exception) {
                                            val errorMsg = e.message ?: "Unknown error"
                                            lastError = errorMsg
                                            coroutineScope.launch {
                                                scaffoldState.snackbarHostState.showSnackbar(errorMsg)
                                            }
                                        } finally {
                                            isGenerating = false
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(backgroundColor = GoldAccent),
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !isBusy
                        ) {
                            Text("Ignite Forge")
                        }
                    } else {
                        Text("Upload a photo to convert to a depth map", color = TextSecondary, fontSize = 14.sp)
                        Spacer(modifier = Modifier.height(8.dp))
                        Button(
                            onClick = { photoPickerLauncher.launch("image/*") },
                            colors = ButtonDefaults.buttonColors(backgroundColor = GrayBorder),
                            enabled = !isBusy
                        ) {
                            Text("Select Photo", color = TextPrimary)
                        }
                        if (selectedPhotoUri != null) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("Photo Selected ✓", color = EmeraldAccent, fontSize = 14.sp)
                        }
                        Spacer(modifier = Modifier.height(16.dp))
                        StylePresetSelector(
                            selectedPreset = selectedStylePreset,
                            onPresetSelected = { selectedStylePreset = it },
                            enabled = !isBusy
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        AspectRatioSelector(
                            selectedRatio = selectedAspectRatio,
                            onRatioSelected = { selectedAspectRatio = it }
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        DepthIntensitySlider(
                            intensity = depthIntensity,
                            onIntensityChange = { depthIntensity = it },
                            enabled = !isBusy
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(
                            onClick = {
                                if (!isBusy) {
                                    selectedPhotoUri?.let { uri ->
                                        isGenerating = true
                                        lastError = null
                                        currentImageUrl = ""
                                        currentBitmap = null
                                        beforeImageUrl = null
                                        beforeBitmap = null
                                        afterImageUrl = null
                                        isComparing = false
                                        isPolished = false
                                        bgRemoved = false
                                        
                                        coroutineScope.launch {
                                            try {
                                                val tempFile = File(context.cacheDir, "upload_temp.jpg")
                                                context.contentResolver.openInputStream(uri)?.use { input ->
                                                    FileOutputStream(tempFile).use { output ->
                                                        input.copyTo(output)
                                                    }
                                                }
                                                val res = ApiClient.photoToDepth(
                                                    file = tempFile,
                                                    aspectRatio = selectedAspectRatio,
                                                    depthIntensity = depthIntensity.toInt(),
                                                    stylePreset = selectedStylePreset
                                                ) // ApiClient.photoToDepth(tempFile, selectedAspectRatio, depthIntensity.toInt()) ApiClient.photoToDepth(tempFile, selectedAspectRatio)
                                                if (res.optString("status") == "success") {
                                                    currentImageUrl = res.getString("image_url")
                                                    currentBitmap = ApiClient.downloadImage(currentImageUrl)
                                                    val (updatedGallery, newItem) = SessionGalleryManager.addItem(
                                                        sessionGallery,
                                                        currentImageUrl,
                                                        currentBitmap,
                                                        "Photo"
                                                    )
                                                    sessionGallery = updatedGallery
                                                    activeGalleryItemId = newItem.id
                                                } else {
                                                    val errorMsg = if (ApiClient.isRateLimited(res)) {
                                                        val serverError = res.optString("error")
                                                        if (serverError.isBlank() || serverError.startsWith("HTTP 429")) {
                                                            "Too many requests. Please wait before generating again."
                                                        } else {
                                                            serverError
                                                        }
                                                    } else {
                                                        res.optString("error").ifEmpty { "Conversion failed" }
                                                    }
                                                    lastError = errorMsg
                                                    coroutineScope.launch {
                                                        scaffoldState.snackbarHostState.showSnackbar(errorMsg)
                                                    }
                                                }
                                            } catch (e: Exception) {
                                                val errorMsg = e.message ?: "Error reading file"
                                                lastError = errorMsg
                                                coroutineScope.launch {
                                                    scaffoldState.snackbarHostState.showSnackbar(errorMsg)
                                                }
                                            } finally {
                                                isGenerating = false
                                            }
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(backgroundColor = IndigoAccent),
                            modifier = Modifier.fillMaxWidth(),
                            enabled = selectedPhotoUri != null && !isBusy
                        ) {
                            Text("Convert to Depth Map")
                        }
                    }

                    if (lastError != null) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(lastError!!, color = Color.Red, fontSize = 14.sp)
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Preview Card
            Card(
                backgroundColor = CardBackground,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, GrayBorder),
                modifier = Modifier.fillMaxWidth().height(300.dp)
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                    when {
                        isGenerating -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(color = GoldAccent)
                                Spacer(modifier = Modifier.height(16.dp))
                                Text("Forging Map in the Cloud...", color = TextPrimary)
                            }
                        }
                        isInverting -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(color = OrangeAccent)
                                Spacer(modifier = Modifier.height(16.dp))
                                Text("Inverting Depth Map...", color = TextPrimary)
                            }
                        }
                        isRemovingBg -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(color = PinkAccent)
                                Spacer(modifier = Modifier.height(16.dp))
                                Text("Isolating Subject...", color = TextPrimary)
                            }
                        }
                        isPolishing -> {
                            // Pipeline step animation overlay
                            Column(
                                modifier = Modifier.padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                val steps = listOf(
                                    "Upscaling" to "Converts 8-bit to 16-bit for mathematical precision",
                                    "Inpainting" to "Fills missing data holes to prevent laser artifacts",
                                    "Bilateral Filtering" to "Removes stair-stepping while preserving edges",
                                    "Normalization" to "Stretches depth to full 16-bit range",
                                    "Lossless Export" to "Saves as compressed 16-bit PNG"
                                )
                                steps.forEachIndexed { index, (title, desc) ->
                                    val alpha = when {
                                        index < activePolishStep -> 0.5f
                                        index == activePolishStep -> 1.0f
                                        else -> 0.2f
                                    }
                                    val borderColor = when {
                                        index < activePolishStep -> EmeraldAccent
                                        index == activePolishStep -> IndigoAccent
                                        else -> Color.Transparent
                                    }
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .alpha(alpha)
                                            .border(1.dp, borderColor, RoundedCornerShape(4.dp))
                                            .padding(8.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column {
                                            Text(title, color = TextPrimary, fontWeight = FontWeight.Bold)
                                            Text(desc, color = TextSecondary, fontSize = 12.sp)
                                        }
                                    }
                                }
                            }
                        }
                        isComparing && beforeBitmap != null && currentBitmap != null -> {
                            BeforeAfterComparisonView(
                                beforeBitmap = beforeBitmap!!,
                                afterBitmap = currentBitmap!!,
                                splitFraction = comparisonSplit,
                                onSplitChange = { comparisonSplit = it },
                                onClose = { isComparing = false }
                            )
                        }
                        currentBitmap != null -> {
                            Image(
                                bitmap = currentBitmap!!.asImageBitmap(),
                                contentDescription = "Generated Map",
                                contentScale = ContentScale.Fit,
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                        else -> {
                            Text("Awaiting Input Parameters", color = TextSecondary)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Session Gallery Strip (F5)
            if (sessionGallery.isNotEmpty()) {
                Card(
                    backgroundColor = CardBackground,
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, GrayBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Session Gallery (${sessionGallery.size})",
                                color = TextPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(
                                    onClick = { isGalleryVisible = !isGalleryVisible },
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                                    modifier = Modifier.height(28.dp),
                                    enabled = !isBusy
                                ) {
                                    Text(if (isGalleryVisible) "Hide" else "Show", color = if (!isBusy) TextSecondary else TextSecondary.copy(alpha = 0.5f), fontSize = 12.sp)
                                }
                                TextButton(
                                    onClick = {
                                        sessionGallery = SessionGalleryManager.clear()
                                        activeGalleryItemId = null
                                        isGalleryVisible = true
                                        beforeImageUrl = null
                                        beforeBitmap = null
                                        afterImageUrl = null
                                        isComparing = false
                                    },
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                                    modifier = Modifier.height(28.dp),
                                    enabled = !isBusy
                                ) {
                                    Text("Clear", color = if (!isBusy) PinkAccent else TextSecondary, fontSize = 12.sp)
                                }
                            }
                        }

                        if (isGalleryVisible) {
                            Spacer(modifier = Modifier.height(8.dp))
                            LazyRow(
                                state = galleryListState,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                items(sessionGallery) { item ->
                                    val isActive = item.id == activeGalleryItemId
                                    Column(
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        modifier = Modifier
                                            .width(84.dp)
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(if (isActive) Color(0xFF1E1B2E) else Color(0xFF0D0D15))
                                            .border(
                                                width = if (isActive) 2.dp else 1.dp,
                                                color = if (isActive) GoldAccent else GrayBorder,
                                                shape = RoundedCornerShape(8.dp)
                                            )
                                            .clickable(enabled = !isBusy) {
                                                activeGalleryItemId = item.id
                                                currentImageUrl = item.imageUrl
                                                currentBitmap = item.bitmap
                                                isComparing = false
                                                isPolished = false
                                                bgRemoved = false
                                                if (item.bitmap == null && item.imageUrl.isNotBlank()) {
                                                    coroutineScope.launch {
                                                        currentBitmap = ApiClient.downloadImage(item.imageUrl)
                                                    }
                                                }
                                            }
                                            .padding(6.dp)
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(72.dp)
                                                .clip(RoundedCornerShape(4.dp))
                                                .background(Color.Black),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            if (item.bitmap != null) {
                                                Image(
                                                    bitmap = item.bitmap.asImageBitmap(),
                                                    contentDescription = item.label,
                                                    contentScale = ContentScale.Crop,
                                                    modifier = Modifier.fillMaxSize()
                                                )
                                            } else {
                                                Text("Map", color = TextSecondary, fontSize = 10.sp)
                                            }
                                        }
                                        Spacer(modifier = Modifier.height(4.dp))
                                        Text(
                                            text = item.label,
                                            color = if (isActive) GoldAccent else TextPrimary,
                                            fontSize = 11.sp,
                                            fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                                            maxLines = 1,
                                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                                        )
                                        Text(
                                            text = item.timestamp,
                                            color = TextSecondary,
                                            fontSize = 9.sp
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(16.dp))
            }

            // Action Buttons
            if (currentImageUrl.isNotBlank() && !isGenerating && !isPolishing) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        OutlinedButton(
                            onClick = {
                                currentImageUrl = ""
                                currentBitmap = null
                                beforeImageUrl = null
                                beforeBitmap = null
                                afterImageUrl = null
                                isComparing = false
                                activeGalleryItemId = null
                                isPolished = false
                                bgRemoved = false
                                promptInput = ""
                            },
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
                            enabled = !isBusy
                        ) {
                            Text("Discard")
                        }

                        if (beforeBitmap != null && currentBitmap != null) {
                            if (currentImageUrl == afterImageUrl) {
                                Button(
                                    onClick = { isComparing = !isComparing },
                                    colors = ButtonDefaults.buttonColors(
                                        backgroundColor = if (isComparing) GoldAccent else CyanAccent
                                    ),
                                    enabled = !isBusy
                                ) {
                                    Text(
                                        text = if (isComparing) "Normal" else "Compare",
                                        color = if (isComparing) DarkBackground else TextPrimary
                                    )
                                }
                            }
                        }

                        Button(
                            onClick = { show3DWebView = true },
                            colors = ButtonDefaults.buttonColors(backgroundColor = PurpleAccent),
                            enabled = !isBusy && currentImageUrl != null
                        ) {
                            Text("🧊 3D Preview", color = TextPrimary)
                        }

                        Button(
                            onClick = {
                                isInverting = true
                                lastError = null
                                val preUrl = currentImageUrl
                                val preBitmap = currentBitmap
                                coroutineScope.launch {
                                    try {
                                        val res = ApiClient.invert(currentImageUrl)
                                        if (res.optString("status") == "success") {
                                            beforeImageUrl = preUrl
                                            beforeBitmap = preBitmap
                                            currentImageUrl = res.getString("image_url")
                                            afterImageUrl = currentImageUrl
                                            currentBitmap = ApiClient.downloadImage(currentImageUrl)
                                            val (updatedGallery, newItem) = SessionGalleryManager.addItem(
                                                sessionGallery,
                                                currentImageUrl,
                                                currentBitmap,
                                                "Invert"
                                            )
                                            sessionGallery = updatedGallery
                                            activeGalleryItemId = newItem.id
                                        } else {
                                            lastError = "Invert failed"
                                        }
                                    } catch (e: Exception) {
                                        lastError = e.message ?: "Invert failed"
                                    } finally {
                                        isInverting = false
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(backgroundColor = OrangeAccent),
                            enabled = !isBusy
                        ) {
                            Text(if (isInverting) "Inverting..." else "Invert")
                        }

                        if (!bgRemoved) {
                            Button(
                                onClick = {
                                    isRemovingBg = true
                                    val preUrl = currentImageUrl
                                    val preBitmap = currentBitmap
                                    coroutineScope.launch {
                                        try {
                                            val res = ApiClient.removeBg(currentImageUrl)
                                            if (res.optString("status") == "success") {
                                                beforeImageUrl = preUrl
                                                beforeBitmap = preBitmap
                                                currentImageUrl = res.getString("image_url")
                                                afterImageUrl = currentImageUrl
                                                currentBitmap = ApiClient.downloadImage(currentImageUrl)
                                                bgRemoved = true
                                                val (updatedGallery, newItem) = SessionGalleryManager.addItem(
                                                    sessionGallery,
                                                    currentImageUrl,
                                                    currentBitmap,
                                                    "Remove BG"
                                                )
                                                sessionGallery = updatedGallery
                                                activeGalleryItemId = newItem.id
                                            }
                                        } catch (e: Exception) {
                                            lastError = "Remove BG failed"
                                        } finally {
                                            isRemovingBg = false
                                        }
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(backgroundColor = PinkAccent),
                                enabled = !isBusy
                            ) {
                                Text(if (isRemovingBg) "Removing..." else "Remove BG")
                            }
                        }
                    }
                    
                    Spacer(modifier = Modifier.height(8.dp))
                    
                    if (!isPolished) {
                        Button(
                            onClick = {
                                isPolishing = true
                                activePolishStep = 0
                                lastError = null
                                val preUrl = currentImageUrl
                                val preBitmap = currentBitmap
                                coroutineScope.launch {
                                    try {
                                        val res = ApiClient.postprocessStream(currentImageUrl) { step, _ ->
                                            activePolishStep = (step - 1).coerceIn(0, 4)
                                        }
                                        if (res.optString("status") == "complete" || res.has("image_url")) {
                                            val newUrl = res.optString("image_url")
                                            if (newUrl.isNotBlank()) {
                                                beforeImageUrl = preUrl
                                                beforeBitmap = preBitmap
                                                currentImageUrl = newUrl
                                                afterImageUrl = currentImageUrl
                                                currentBitmap = ApiClient.downloadImage(currentImageUrl)
                                                isPolished = true
                                                val (updatedGallery, newItem) = SessionGalleryManager.addItem(
                                                    sessionGallery,
                                                    currentImageUrl,
                                                    currentBitmap,
                                                    "Polish"
                                                )
                                                sessionGallery = updatedGallery
                                                activeGalleryItemId = newItem.id
                                            } else {
                                                lastError = "Polish failed"
                                            }
                                        } else {
                                            lastError = res.optString("error", "Polish failed")
                                        }
                                    } catch (e: Exception) {
                                        lastError = e.message ?: "Polish failed"
                                    } finally {
                                        isPolishing = false
                                        activePolishStep = -1
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(backgroundColor = IndigoAccent),
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !isBusy
                        ) {
                            Text("Polish for CNC")
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                    }

                    Button(
                        onClick = {
                            currentBitmap?.let { bitmap ->
                                coroutineScope.launch {
                                    try {
                                        withContext(Dispatchers.IO) {
                                            saveImageToGallery(context, bitmap, "DepthForge_${System.currentTimeMillis()}")
                                        }
                                        scaffoldState.snackbarHostState.showSnackbar("Saved!")
                                    } catch (e: Exception) {
                                        scaffoldState.snackbarHostState.showSnackbar("Failed to save")
                                    }
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(backgroundColor = EmeraldAccent),
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !isBusy && currentBitmap != null
                    ) {
                        Text("Download")
                    }
                }
            }
        }

        if (show3DWebView && currentImageUrl != null) {
            BackHandler { show3DWebView = false }
            Dialog(
                onDismissRequest = { show3DWebView = false },
                properties = DialogProperties(
                    dismissOnBackPress = true,
                    dismissOnClickOutside = false,
                    usePlatformDefaultWidth = false
                )
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .fillMaxHeight(0.85f)
                        .clip(RoundedCornerShape(16.dp))
                        .background(CardBackground)
                ) {
                    // Title bar
                    Text(
                        text = "🧊 3D Live Preview",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Serif,
                        fontSize = 16.sp,
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .padding(top = 12.dp)
                    )

                    // WebView with Three.js 3D displacement preview
                    @SuppressLint("SetJavaScriptEnabled")
                    val webViewRef = remember { mutableStateOf<WebView?>(null) }
                    val imageUrl = currentImageUrl ?: ""

                    AndroidView(
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.allowFileAccess = true
                                settings.mediaPlaybackRequiresUserGesture = false
                                settings.useWideViewPort = true
                                settings.loadWithOverviewMode = true
                                setBackgroundColor(android.graphics.Color.parseColor("#14141C"))

                                webViewClient = object : WebViewClient() {
                                    override fun onPageFinished(view: WebView?, url: String?) {
                                        super.onPageFinished(view, url)
                                        // Inject JS to set the current image and enter 3D preview
                                        val escapedUrl = imageUrl.replace("'", "\\'")
                                        val jsPayload = """
                                            (function() {
                                                if (typeof currentImageUrl !== 'undefined') {
                                                    currentImageUrl = '$escapedUrl';
                                                }
                                                var img = document.getElementById('outputImage');
                                                if (img) {
                                                    img.src = '$escapedUrl';
                                                    img.style.display = 'block';
                                                }
                                                if (typeof showOutput === 'function') {
                                                    showOutput('$escapedUrl');
                                                }
                                                setTimeout(function() {
                                                    if (typeof enter3DPreview === 'function') {
                                                        enter3DPreview();
                                                    }
                                                }, 500);
                                            })();
                                        """.trimIndent()
                                        view?.evaluateJavascript(jsPayload, null)
                                    }

                                    override fun shouldOverrideUrlLoading(
                                        view: WebView?,
                                        request: WebResourceRequest?
                                    ): Boolean {
                                        // Keep navigation within the WebView for local assets
                                        return false
                                    }
                                }

                                webViewRef.value = this
                                loadUrl("file:///android_asset/index.html")
                            }
                        },
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(top = 44.dp, bottom = 56.dp)
                    )

                    // Close button at bottom
                    Button(
                        onClick = {
                            webViewRef.value?.destroy()
                            show3DWebView = false
                        },
                        colors = ButtonDefaults.buttonColors(backgroundColor = GoldAccent),
                        shape = RoundedCornerShape(20.dp),
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 12.dp)
                    ) {
                        Text("✕ Close 3D Preview", color = DarkBackground, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

private fun saveImageToGallery(context: Context, bitmap: Bitmap, title: String) {
    val resolver = context.contentResolver
    val contentValues = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, "$title.png")
        put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/DepthForge")
        }
    }
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
    if (uri != null) {
        resolver.openOutputStream(uri).use { stream ->
            if (stream != null) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
            }
        }
    }
}

@Composable
fun BeforeAfterComparisonView(
    beforeBitmap: Bitmap,
    afterBitmap: Bitmap,
    splitFraction: Float,
    onSplitChange: (Float) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier
) {
    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black)
    ) {
        val totalWidth = maxWidth
        val totalHeight = maxHeight
        val splitWidth = totalWidth * splitFraction.coerceIn(0f, 1f)
        val totalPx = with(LocalDensity.current) { totalWidth.toPx() }

        // Comparison Interactive Surface (supports dragging anywhere)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        if (totalPx > 0f) {
                            val newFraction = (splitFraction + delta / totalPx).coerceIn(0f, 1f)
                            onSplitChange(newFraction)
                        }
                    }
                )
        ) {
            // Before Image (Left / Base layer)
            Box(modifier = Modifier.fillMaxSize()) {
                Image(
                    bitmap = beforeBitmap.asImageBitmap(),
                    contentDescription = "Before Map",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                )
            }

            // After Image (Right / Clipped overlay)
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(object : androidx.compose.ui.graphics.Shape {
                        override fun createOutline(
                            size: androidx.compose.ui.geometry.Size,
                            layoutDirection: androidx.compose.ui.unit.LayoutDirection,
                            density: androidx.compose.ui.unit.Density
                        ): androidx.compose.ui.graphics.Outline {
                            val leftCut = size.width * splitFraction.coerceIn(0f, 1f)
                            return androidx.compose.ui.graphics.Outline.Rectangle(
                                androidx.compose.ui.geometry.Rect(
                                    left = leftCut,
                                    top = 0f,
                                    right = size.width,
                                    bottom = size.height
                                )
                            )
                        }
                    })
            ) {
                Image(
                    bitmap = afterBitmap.asImageBitmap(),
                    contentDescription = "After Map",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                )
            }

            // Before label badge (fades out smoothly when split is near 0)
            val beforeAlpha = (splitFraction / 0.15f).coerceIn(0f, 1f)
            if (beforeAlpha > 0f) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(8.dp)
                        .alpha(beforeAlpha)
                        .background(Color(0xCC14141C), RoundedCornerShape(4.dp))
                        .border(1.dp, OrangeAccent, RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = "Before",
                        color = OrangeAccent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            // After label badge (fades out smoothly when split is near 1)
            val afterAlpha = ((1f - splitFraction) / 0.15f).coerceIn(0f, 1f)
            if (afterAlpha > 0f) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .alpha(afterAlpha)
                        .background(Color(0xCC14141C), RoundedCornerShape(4.dp))
                        .border(1.dp, IndigoAccent, RoundedCornerShape(4.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = "After",
                        color = IndigoAccent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            // Draggable vertical divider handle
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(48.dp)
                    .offset(x = splitWidth - 24.dp),
                contentAlignment = Alignment.Center
            ) {
                // Vertical divider line
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(2.dp)
                        .background(GoldAccent)
                )
                // Handle circle indicator
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .background(CardBackground, RoundedCornerShape(16.dp))
                        .border(2.dp, GoldAccent, RoundedCornerShape(16.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "◀▶",
                        color = GoldAccent,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        // Close Comparison button overlay
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 8.dp)
        ) {
            Button(
                onClick = onClose,
                colors = ButtonDefaults.buttonColors(backgroundColor = CardBackground.copy(alpha = 0.9f)),
                border = BorderStroke(1.dp, GrayBorder),
                shape = RoundedCornerShape(16.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                modifier = Modifier.height(30.dp)
            ) {
                Text("✕ Close Comparison", color = TextPrimary, fontSize = 11.sp)
            }
        }
    }
}
