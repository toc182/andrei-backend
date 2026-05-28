import { Request, Response, NextFunction } from 'express';

// Multer decodes the multipart filename as Latin-1, but browsers send it as
// UTF-8. The result: "GESTIÓN.pdf" arrives as "GESTIÃN.pdf". Re-decoding the
// bytes as UTF-8 restores the original characters.
export function fixFilenameEncoding(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf8');
}

function fixFile(f: Express.Multer.File): void {
  f.originalname = fixFilenameEncoding(f.originalname);
}

// Mutates req.file / req.files in place. Safe to call when nothing is set.
export function fixFiles(req: Request): void {
  if (req.file) fixFile(req.file);
  if (Array.isArray(req.files)) {
    req.files.forEach(fixFile);
  } else if (req.files && typeof req.files === 'object') {
    for (const arr of Object.values(req.files)) {
      (arr as Express.Multer.File[]).forEach(fixFile);
    }
  }
}

// Express middleware. Use right after upload.single/array/fields so every
// downstream handler sees originalname with correct UTF-8.
export function fixUploadEncoding(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  fixFiles(req);
  next();
}
