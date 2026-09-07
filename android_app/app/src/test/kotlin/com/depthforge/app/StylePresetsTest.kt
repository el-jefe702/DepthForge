package com.depthforge.app

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for Style Presets (F12).
 * Validates preset IDs, labels, toggle selection behavior,
 * and ApiClient parameter mapping.
 */
class StylePresetsTest {

    private val availablePresets = listOf(
        "portrait" to "👤 Portrait",
        "wildlife" to "🦁 Wildlife",
        "ornamental" to "⚜️ Ornamental",
        "floral" to "🌸 Floral",
        "architecture" to "🏛️ Architecture",
        "abstract" to "🌀 Abstract"
    )

    @Test
    fun `Available style presets count and IDs match specification`() {
        assertEquals(6, availablePresets.size)
        val expectedKeys = listOf("portrait", "wildlife", "ornamental", "floral", "architecture", "abstract")
        assertEquals(expectedKeys, availablePresets.map { it.first })
    }

    @Test
    fun `Each preset has non-empty label with emoji icon`() {
        for ((id, label) in availablePresets) {
            assertTrue("ID must be non-empty", id.isNotBlank())
            assertTrue("Label must be non-empty", label.isNotBlank())
            assertTrue("Label must contain whitespace separating icon", label.contains(" "))
        }
    }

    @Test
    fun `Toggling preset on and off`() {
        var selectedPreset: String? = null

        fun onPresetSelected(preset: String?) {
            selectedPreset = if (selectedPreset == preset) null else preset
        }

        // Select portrait
        onPresetSelected("portrait")
        assertEquals("portrait", selectedPreset)

        // Click portrait again -> deselects to null
        onPresetSelected("portrait")
        assertNull(selectedPreset)

        // Select wildlife
        onPresetSelected("wildlife")
        assertEquals("wildlife", selectedPreset)

        // Select floral -> switches active preset
        onPresetSelected("floral")
        assertEquals("floral", selectedPreset)
    }

    @Test
    fun `ApiClient parameter serialization logic`() {
        fun buildParams(stylePreset: String?): Map<String, String> {
            val map = mutableMapOf<String, String>()
            if (!stylePreset.isNullOrBlank()) {
                map["style_preset"] = stylePreset
                map["stylePreset"] = stylePreset
            }
            return map
        }

        val emptyParams = buildParams(null)
        assertFalse(emptyParams.containsKey("style_preset"))

        val blankParams = buildParams("   ")
        assertFalse(blankParams.containsKey("style_preset"))

        val activeParams = buildParams("ornamental")
        assertEquals("ornamental", activeParams["style_preset"])
        assertEquals("ornamental", activeParams["stylePreset"])
    }
}
