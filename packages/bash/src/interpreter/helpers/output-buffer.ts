export class OutputBuffer {
  private chunks: string[] = [];
  private byteLength = 0;

  push(chunk: string): void {
    if (chunk) {
      this.chunks.push(chunk);
      this.byteLength += chunk.length;
    }
  }

  toString(): string {
    return this.chunks.join("");
  }

  get length(): number {
    return this.byteLength;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  clear(): void {
    this.chunks = [];
    this.byteLength = 0;
  }
}
