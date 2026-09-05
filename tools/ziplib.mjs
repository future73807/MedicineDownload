// 零依赖 ZIP 打包库（deflate 压缩，增量写盘，内存占用平缓）
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = seed ^ -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// 增量写 zip 的类：addFile(archivePath, diskPath) → 最后 close()
export class ZipWriter {
  constructor(outPath, level = 6) {
    this.fd = fs.openSync(outPath, "w");
    this.offset = 0;
    this.level = level;
    this.central = []; // {name, crc, csize, usize, offset, time, date}
    this.bytesWritten = 0;
  }
  async addFile(archivePath, diskPath) {
    const data = await fs.promises.readFile(diskPath);
    const raw = await new Promise((res, rej) =>
      zlib.deflateRaw(data, { level: this.level }, (e, b) => (e ? rej(e) : res(b))));
    const crc = crc32(data);
    const { time, date } = dosDateTime();
    const name = Buffer.from(archivePath.replace(/\\/g, "/"), "utf8");
    const useZip64 = raw.length >= 0xffffffff || data.length >= 0xffffffff;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(useZip64 ? 45 : 20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // utf-8 flag
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(useZip64 ? 0xffffffff : raw.length, 18);
    lh.writeUInt32LE(useZip64 ? 0xffffffff : data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(useZip64 ? 20 : 0, 28);
    const extra = useZip64 ? (() => {
      const b = Buffer.alloc(20);
      b.writeUInt16LE(0x0001, 0); b.writeUInt16LE(16, 2);
      b.writeBigUInt64LE(BigInt(data.length), 4);
      b.writeBigUInt64LE(BigInt(raw.length), 12);
      return b;
    })() : Buffer.alloc(0);
    this._write(lh); this._write(name); this._write(extra); this._write(raw);
    this.central.push({ name, crc, csize: raw.length, usize: data.length, offset: this.offset - raw.length - name.length - extra.length - 30, time, date, useZip64 });
  }
  _write(buf) { fs.writeSync(this.fd, buf); this.offset += buf.length; this.bytesWritten += buf.length; }
  close() {
    const cdStart = this.offset;
    for (const e of this.central) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(e.useZip64 ? 45 : 20, 4);
      cd.writeUInt16LE(e.useZip64 ? 45 : 20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt16LE(e.time, 12);
      cd.writeUInt16LE(e.date, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.useZip64 ? 0xffffffff : e.csize, 20);
      cd.writeUInt32LE(e.useZip64 ? 0xffffffff : e.usize, 24);
      cd.writeUInt16LE(e.name.length, 28);
      cd.writeUInt16LE(e.useZip64 ? 20 : 0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(e.useZip64 ? 0xffffffff : e.offset, 42);
      this._write(cd); this._write(e.name);
      if (e.useZip64) {
        const x = Buffer.alloc(20);
        x.writeUInt16LE(0x0001, 0); x.writeUInt16LE(16, 2);
        x.writeBigUInt64LE(BigInt(e.usize), 4);
        x.writeBigUInt64LE(BigInt(e.offset), 12);
        this._write(x);
      }
    }
    const cdSize = this.offset - cdStart;
    const total = this.central.length;
    const needs64 = cdStart >= 0xffffffff || cdSize >= 0xffffffff || total >= 0xffff;
    if (needs64) {
      const z64 = Buffer.alloc(56), z64loc = Buffer.alloc(20);
      z64.writeUInt32LE(0x06064b50, 0);
      z64.writeBigUInt64LE(BigInt(44), 4);
      z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14);
      z64.writeBigUInt64LE(BigInt(total), 24); z64.writeBigUInt64LE(BigInt(total), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40); z64.writeBigUInt64LE(BigInt(cdStart), 48);
      z64loc.writeUInt32LE(0x07064b50, 0);
      z64loc.writeUInt32LE(0xffffffff, 4); z64loc.writeUInt32LE(0xffffffff, 8);
      z64loc.writeBigUInt64LE(BigInt(cdStart), 12);
      this._write(z64); this._write(z64loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Math.min(total, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(total, 0xffff), 10);
    eocd.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12);
    eocd.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
    this._write(eocd);
    fs.closeSync(this.fd);
    return this.bytesWritten;
  }
}
