const SPACE = /\s/;
const LITERAL_END = /[\s,;(){}=]/;

class NativeXcodeSyntaxError extends Error {}

class Reader {
  private at = 0;
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  parseDocument(): unknown {
    const value = this.value();
    this.skip();
    if (this.at < this.source.length) this.fail('unexpected text after the project');
    return value;
  }

  private fail(reason: string): never {
    throw new NativeXcodeSyntaxError(`Cannot parse project.pbxproj: ${reason} at offset ${this.at}.`);
  }

  private skip() {
    const { source } = this;
    while (this.at < source.length) {
      if (SPACE.test(source[this.at]!)) this.at++;
      else if (source.startsWith('/*', this.at)) {
        const end = source.indexOf('*/', this.at + 2);
        if (end < 0) this.fail('unterminated comment');
        this.at = end + 2;
      } else if (source.startsWith('//', this.at)) {
        const end = source.indexOf('\n', this.at);
        this.at = end < 0 ? source.length : end + 1;
      } else break;
    }
  }

  private expect(char: string) {
    this.skip();
    if (this.source[this.at] !== char) this.fail(`expected "${char}"`);
    this.at++;
  }

  private value(): unknown {
    this.skip();
    const char = this.source[this.at];
    if (char === '{') return this.dictionary();
    if (char === '(') return this.list();
    return this.string();
  }

  private dictionary(): Record<string, unknown> {
    this.at++;
    const result: Record<string, unknown> = Object.create(null);
    for (;;) {
      this.skip();
      if (this.source[this.at] === '}') break;
      const key = this.string();
      this.expect('=');
      result[key] = this.value();
      this.expect(';');
    }
    this.at++;
    return result;
  }

  private list(): unknown[] {
    this.at++;
    const result: unknown[] = [];
    for (;;) {
      this.skip();
      if (this.source[this.at] === ')') break;
      result.push(this.value());
      this.skip();
      if (this.source[this.at] === ',') this.at++;
      else if (this.source[this.at] !== ')') this.fail('expected "," or ")"');
    }
    this.at++;
    return result;
  }

  private string(): string {
    const { source } = this;
    const start = this.at;
    if (source[start] === '"') {
      this.at++;
      while (this.at < source.length && source[this.at] !== '"') this.at += source[this.at] === '\\' ? 2 : 1;
      if (this.at >= source.length) this.fail('unterminated string');
      this.at++;
      return source.slice(start, this.at);
    }
    while (this.at < source.length && !LITERAL_END.test(source[this.at]!)) {
      if (source.startsWith('$(', this.at)) {
        let depth = 0;
        this.at++;
        do {
          if (source[this.at] === '(') depth++;
          else if (source[this.at] === ')') depth--;
          this.at++;
        } while (this.at < source.length && depth > 0);
      } else this.at++;
    }
    if (this.at === start) this.fail('expected a value');
    return source.slice(start, this.at);
  }
}

export function parseNativeXcodeSyntax(source: string): unknown {
  return new Reader(source).parseDocument();
}
