export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type FileStat = {
  mtimeMs: number;
  size: number;
};

export type Shell = {
  exec(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  stat?(path: string): Promise<FileStat>;
};
