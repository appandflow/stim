export interface SetupDisplay {
  tty: boolean;
  color: boolean;
  raw(text: string): void;
}

type StepState = 'ok' | 'running' | 'failed' | 'pending' | 'skipped';

export interface StepText {
  id: string;
  state: StepState;
  title: string;
  detail?: string;
  fix?: string;
  text?: string;
  running?: string;
  hidden?: boolean;
}

export function setupDisplayFor(
  stdoutIsTty: boolean,
  env: Record<string, string | undefined>,
  raw: (text: string) => void,
): SetupDisplay {
  const color = stdoutIsTty && !env.NO_COLOR && env.TERM !== 'dumb';
  return { tty: stdoutIsTty, color, raw };
}

const BANNER = [
  '      _   _',
  '  ___| |_(_)_ __ ___        ___  ___ _ ____   _____ _ __',
  " / __| __| | '_ ` _ \\ ____ / __|/ _ \\ '__\\ \\ / / _ \\ '__|",
  ' \\__ \\ |_| | | | | | |____|\\__ \\  __/ |   \\ V /  __/ |',
  ' |___/\\__|_|_| |_| |_|     |___/\\___|_|    \\_/ \\___|_|',
];

const CODES = { green: 32, yellow: 33, red: 31, dim: 2, bold: 1 } as const;
const WAITING = new Set(['approve', 'permissions.screenRecording', 'permissions.deviceControl']);

export class SetupPrinter {
  private transient = false;

  private readonly write: (line: string) => void;
  private readonly display: SetupDisplay;
  private readonly verbose: boolean;

  constructor(write: (line: string) => void, display: SetupDisplay, verbose: boolean) {
    this.write = write;
    this.display = display;
    this.verbose = verbose;
  }

  private paint(code: keyof typeof CODES, text: string): string {
    return this.display.color ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text;
  }

  private mark(state: StepState): string {
    const { color } = this.display;
    if (state === 'ok') return color ? this.paint('green', '✓') : '[ok]';
    if (state === 'failed') return color ? this.paint('red', '✗') : '[failed]';
    if (state === 'running') return color ? this.paint('yellow', '→') : '[..]';
    return color ? this.paint('yellow', '!') : `[${state}]`;
  }

  clear(): void {
    if (!this.transient) return;
    this.display.raw('\r\u001b[2K');
    this.transient = false;
  }

  line(text: string): void {
    this.clear();
    this.write(text);
  }

  banner(): void {
    if (!this.display.tty) return;
    this.write(this.paint('bold', BANNER.join('\n')));
    this.write('');
  }

  step(step: StepText): void {
    if (this.verbose) {
      const { state, title, detail, fix } = step;
      this.line(`[${state}] ${title}${detail ? `: ${detail}` : ''}${fix ? `\nFix: ${fix}` : ''}`);
      return;
    }
    if (step.state === 'running') {
      if (!step.running) return;
      if (this.display.tty && this.display.color) {
        this.clear();
        this.display.raw(`${this.mark('running')} ${step.running}`);
        this.transient = true;
      } else if (WAITING.has(step.id)) {
        this.line(`${this.mark('running')} ${step.running}`);
      }
      return;
    }
    if (step.hidden) {
      this.clear();
      return;
    }
    const text = step.text ?? `${step.title}${step.detail ? `: ${step.detail}` : ''}`;
    this.line(`${this.mark(step.state)} ${text}`);
  }

  result(lines: { state: StepState; text: string }[]): void {
    this.clear();
    for (const { state, text } of lines) this.write(`${this.mark(state)} ${text}`);
  }

  headline(state: StepState, text: string): void {
    this.clear();
    this.write('');
    this.write(
      `${this.mark(state)} ${this.paint(state === 'ok' ? 'green' : state === 'failed' ? 'red' : 'yellow', text)}`,
    );
  }

  dim(text: string): void {
    this.line(this.paint('dim', text));
  }
}
