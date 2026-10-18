import fs from 'node:fs';
import path from 'node:path';

let s3ClientInstance = null;

export async function getS3Client() {
    if (s3ClientInstance) return s3ClientInstance;

    const bucket = process.env.S3_BUCKET;
    if (!bucket) return null;

    try {
        const { S3Client } = await import('@aws-sdk/client-s3');
        s3ClientInstance = new S3Client({
            region: process.env.S3_REGION || 'auto',
            endpoint: process.env.S3_ENDPOINT || undefined,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || '',
                secretAccessKey: process.env.S3_SECRET_KEY || ''
            },
            forcePathStyle: Boolean(process.env.S3_FORCE_PATH_STYLE === 'true' || process.env.S3_ENDPOINT)
        });
        return s3ClientInstance;
    } catch (err) {
        console.warn('[Storage] S3 client initialization skipped or failed:', err.message);
        return null;
    }
}

/**
 * Uploads a local file to S3-compatible cloud storage if configured.
 * Gracefully falls back to local URL if S3 is not configured or fails.
 *
 * @param {string} localFilePath - Absolute path to local file
 * @param {string} filename - Base name of the file
 * @param {string} [contentType='image/png'] - MIME type
 * @returns {Promise<string>} Public URL or local static URL
 */
export async function uploadGeneratedImage(localFilePath, filename, contentType = 'image/png') {
    const bucket = process.env.S3_BUCKET;
    const defaultLocalUrl = `/static/generated/${filename}`;

    if (!bucket) {
        return defaultLocalUrl;
    }

    try {
        const client = await getS3Client();
        if (!client) {
            return defaultLocalUrl;
        }

        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const fileStream = fs.createReadStream(localFilePath);
        const objectKey = `depth-maps/${filename}`;

        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            Body: fileStream,
            ContentType: contentType
        }));

        if (process.env.S3_PUBLIC_URL) {
            const baseUrl = process.env.S3_PUBLIC_URL.replace(/\/+$/, '');
            return `${baseUrl}/${objectKey}`;
        }

        if (process.env.S3_ENDPOINT) {
            const endpoint = process.env.S3_ENDPOINT.replace(/\/+$/, '');
            return `${endpoint}/${bucket}/${objectKey}`;
        }

        return `https://${bucket}.s3.amazonaws.com/${objectKey}`;
    } catch (err) {
        console.error(`[Storage] Failed to upload ${filename} to S3, falling back to local:`, err.message);
        return defaultLocalUrl;
    }
}

