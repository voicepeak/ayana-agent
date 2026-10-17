declare module 'unzipper' {
  export interface Directory {
    extract(options: { path: string; concurrency?: number }): Promise<void>;
  }
  export const Open: {
    file(path: string, options?: Record<string, unknown>): Promise<Directory>;
  };
}
