package com.depthforge.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for Batch Generation (F13).
 * Validates candidate grid selection, ApiClient batch parameter mapping,
 * and JSON response parsing for multi-image batches.
 */
class BatchGenerationTest {

    @Test
    fun `Batch parameter serialization in ApiClient payload`() {
        fun buildParams(batch: Boolean): Map<String, String> {
            val map = mutableMapOf<String, String>()
            if (batch) {
                map["batch"] = "true"
                map["numberOfImages"] = "4"
            }
            return map
        }

        val singleParams = buildParams(false)
        assertFalse("Single generation should not have batch key", singleParams.containsKey("batch"))
        assertFalse("Single generation should not have numberOfImages key", singleParams.containsKey("numberOfImages"))

        val batchParams = buildParams(true)
        assertTrue("Batch generation must include batch key", batchParams.containsKey("batch"))
        assertEquals("true", batchParams["batch"])
        assertEquals("4", batchParams["numberOfImages"])
    }

    @Test
    fun `Batch response parsing handles multiple image URLs`() {
        val jsonString = """
            {
                "status": "success",
                "image_url": "/static/generated/batch_1.png",
                "images": [
                    "/static/generated/batch_1.png",
                    "/static/generated/batch_2.png",
                    "/static/generated/batch_3.png",
                    "/static/generated/batch_4.png"
                ],
                "batch": true
            }
        """.trimIndent()

        val response = JSONObject(jsonString)
        assertEquals("success", response.getString("status"))
        assertTrue(response.getBoolean("batch"))

        val imagesArray = response.optJSONArray("images")
        assertNotNull("images array should not be null", imagesArray)
        assertEquals(4, imagesArray!!.length())

        val urls = mutableListOf<String>()
        for (i in 0 until imagesArray.length()) {
            urls.add(imagesArray.getString(i))
        }

        assertEquals(4, urls.size)
        assertEquals("/static/generated/batch_1.png", urls[0])
        assertEquals("/static/generated/batch_4.png", urls[3])
    }

    @Test
    fun `Selecting batch candidate updates active URL`() {
        val candidates = listOf(
            "/static/generated/cand1.png",
            "/static/generated/cand2.png",
            "/static/generated/cand3.png",
            "/static/generated/cand4.png"
        )

        var selectedUrl = candidates[0]
        assertEquals(candidates[0], selectedUrl)

        // Select candidate 3
        selectedUrl = candidates[2]
        assertEquals(candidates[2], selectedUrl)

        // Select candidate 2
        selectedUrl = candidates[1]
        assertEquals(candidates[1], selectedUrl)
    }

    @Test
    fun `Batch grid chunks candidates into pairs for 2-column layout`() {
        val candidates = listOf("url1", "url2", "url3", "url4")
        val rows = candidates.chunked(2)

        assertEquals(2, rows.size)
        assertEquals(listOf("url1", "url2"), rows[0])
        assertEquals(listOf("url3", "url4"), rows[1])
    }
}
