// The office can share one Google Drive folder or file with the customer for the project's photos and videos
// (crew photo storage takes images only). The Hub finance card saves it on the job as projectMedia
// { url, updatedAt, updatedBy }, and the customer portal shows it as a button. Only a Drive link is ever served:
// the id is read from the saved URL and the link is rebuilt from it, so no other host, query or fragment reaches
// the customer. employee-suite.js (projectMediaLink) applies the same rule before it saves.
const FOLDER = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d{1,2}\/)?folders\/([A-Za-z0-9_-]{10,100})(?:[/?#]|$)/;
const FILE = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,100})(?:[/?#]|$)/;

export function projectMediaUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 500) return '';
  const folder = FOLDER.exec(text);
  if (folder) return `https://drive.google.com/drive/folders/${folder[1]}`;
  const file = FILE.exec(text);
  return file ? `https://drive.google.com/file/d/${file[1]}/view` : '';
}

export function customerProjectMedia(job) {
  const url = projectMediaUrl(job?.projectMedia?.url);
  return url ? { url } : null;
}
