import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

let instance: S3Client | undefined;

function driver() {
  return (process.env.STORAGE_DRIVER ?? "s3").toLowerCase();
}

function storage() {
  if (instance) return instance;
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION ?? "auto";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 storage credentials are required when STORAGE_DRIVER=s3");
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
  if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  return process.env.S3_BUCKET;
}

function localRoot() {
  return path.resolve(process.env.STORAGE_PATH ?? "/data/egc");
}

function localPath(key: string) {
  const root = localRoot();
  const normalizedKey = key.replaceAll("\\", "/").replace(/^\/+/, "");
  const resolved = path.resolve(root, normalizedKey);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return resolved;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  if (driver() === "filesystem") {
    const target = localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return key;
  }

  if (driver() !== "s3") {
    throw new Error(`Unsupported STORAGE_DRIVER: ${driver()}`);
  }

  await storage().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentType: contentType
  }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  if (driver() === "filesystem") {
    return readFile(localPath(key));
  }

  if (driver() !== "s3") {
    throw new Error(`Unsupported STORAGE_DRIVER: ${driver()}`);
  }

  const result = await storage().send(new GetObjectCommand({
    Bucket: bucket(),
    Key: key
  }));
  if (!result.Body) throw new Error("Object body missing");
  return Buffer.from(await result.Body.transformToByteArray());
}
