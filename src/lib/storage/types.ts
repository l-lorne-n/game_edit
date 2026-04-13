export type PutOptions = {
  contentType?: string;
};

export type StorageFileEntry = {
  path: string;
  url: string;
  size: number;
  contentType?: string;
};

export interface StorageProvider {
  readonly name: string;
  put(path: string, content: string | Buffer, options?: PutOptions): Promise<string>;
  get(path: string): Promise<string | null>;
  del(path: string): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<StorageFileEntry[]>;
  head(path: string): Promise<string | null>;
  copy(sourcePath: string, destPath: string): Promise<string>;
}
