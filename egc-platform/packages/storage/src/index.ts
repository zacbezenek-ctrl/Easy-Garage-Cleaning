import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

let instance: S3Client | undefined;

function storage() {
  if (instance) return instance;
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION ?? "auto";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 storage credentials are required");
  }

  instance = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
  });
  return instance;
}

function bucket() {
  if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required");
  return process.env.S3_BUCKET;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await storage().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType
  }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const result = await storage().send(new GetObjectCommand({
    Bucket: bucket(),
    Key: key
  }));
  if (!result.Body) throw new Error("Object body missing");
  return Buffer.from(await result.Body.transformToByteArray());
}
