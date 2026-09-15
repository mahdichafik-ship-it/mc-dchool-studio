import { objectStorageService } from "./objectStorage";

export async function storePhotoDurably(localPath: string, mimeType: string): Promise<string> {
  return objectStorageService.uploadLocalFile(localPath, mimeType);
}