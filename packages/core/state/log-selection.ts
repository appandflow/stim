export class BoundedSelection<T> {
  private readonly first: boolean;
  private readonly compare: (a: T, b: T) => number;
  private readonly tail: number | undefined;
  constructor(compare: (a: T, b: T) => number, tail?: number, first = false) {
    this.first = first;
    this.compare = compare;
    this.tail = tail;
  }

  private before(a: T, b: T): boolean {
    return (this.first ? this.compare(b, a) : this.compare(a, b)) < 0;
  }

  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  keep(entry: T): void {
    if (this.tail !== undefined && this.tail <= 0) return;
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
    if (this.tail !== undefined && items.length > this.tail) this.pop();
  }

  sorted(): T[] {
    return this.items.toSorted(this.compare);
  }

  private pop(): void {
    const items = this.items;
    const last = items.pop()!;
    if (!items.length) return;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < items.length && this.before(items[left]!, items[least]!)) least = left;
      if (right < items.length && this.before(items[right]!, items[least]!)) least = right;
      if (least === i) return;
      [items[i], items[least]] = [items[least]!, items[i]!];
      i = least;
    }
  }
}
