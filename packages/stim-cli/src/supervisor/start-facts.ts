export interface StartFacts {
  port: number;
  supervisorPid: number | null;
  mode: string | null;
  logsDir: string;
  alreadyRunning: boolean;
}

export interface StartError {
  code: string;
  message: string;
  remedy: string | null;
}
