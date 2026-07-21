export class BoundedByteTail {
  #bytes = Buffer.alloc(0);

  constructor(limitBytes = 8 * 1024) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new RangeError("bounded byte tail limit must be a positive safe integer");
    }
    this.limitBytes = limitBytes;
  }

  append(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length >= this.limitBytes) {
      this.#bytes = Buffer.from(incoming.subarray(incoming.length - this.limitBytes));
      return;
    }
    const keep = Math.min(this.#bytes.length, this.limitBytes - incoming.length);
    this.#bytes = Buffer.concat([this.#bytes.subarray(this.#bytes.length - keep), incoming], keep + incoming.length);
  }

  toString(encoding = "utf8") {
    return this.#bytes.toString(encoding);
  }

  get byteLength() {
    return this.#bytes.length;
  }
}
