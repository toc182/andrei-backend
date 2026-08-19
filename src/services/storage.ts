import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (!s3Client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'R2 storage not configured: missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY',
      );
    }

    const endpoint =
      process.env.R2_ENDPOINT ||
      `https://${accountId}.r2.cloudflarestorage.com`;

    s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }
  return s3Client;
}

const getBucket = (): string => {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error('R2_BUCKET_NAME not configured');
  return bucket;
};

export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

export async function deleteFile(key: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
}

export async function downloadFile(key: string): Promise<Buffer> {
  const client = getClient();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Enlace temporal al archivo.
 *
 * `nombreDescarga` fuerza con qué nombre lo guarda el navegador. Sin él, el
 * nombre sale de la clave en R2 -- que lleva un UUID delante y el nombre que
 * traía el archivo cuando se subió. Para los módulos donde el nombre se puede
 * cambiar después, eso significaría bajar un archivo con el nombre viejo.
 */
export async function getFileSignedUrl(
  key: string,
  expiresIn = 900,
  nombreDescarga?: string,
): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ...(nombreDescarga
      ? {
        // El nombre viaja en una cabecera, así que las comillas y los saltos
        // de línea se quedan fuera; el resto (acentos incluidos) va en UTF-8
        // por la forma `filename*`, que es la que entienden los navegadores.
        ResponseContentDisposition:
            `attachment; filename*=UTF-8''${encodeURIComponent(nombreDescarga.replace(/[\r\n"]/g, ''))}`,
      }
      : {}),
  });
  return getSignedUrl(client, command, { expiresIn });
}
