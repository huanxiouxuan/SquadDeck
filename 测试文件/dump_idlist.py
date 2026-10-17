# dump_idlist.py - 全量 hexdump .lnk 的 IDList 区域（不截断），16 字节一行带偏移
import struct, sys

def main(path):
    data = open(path, 'rb').read()
    hdrsz, = struct.unpack_from('<I', data, 0)
    flags, = struct.unpack_from('<I', data, 20)
    if not (flags & 0x01):
        print('no IDList'); return
    off = hdrsz
    start = off
    items = []
    while True:
        isz, = struct.unpack_from('<H', data, off)
        if isz == 0:
            off += 2
            break
        items.append(data[off:off + isz])
        off += isz
    blob = data[start:off]
    print('%s  IDList=%d bytes (%d items)' % (path, len(blob), len(items)))
    for base in range(0, len(blob), 16):
        chunk = blob[base:base + 16]
        hexs = ' '.join('%02x' % b for b in chunk)
        asc = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        print('  +%04x  %-47s  %s' % (base, hexs, asc))

if __name__ == '__main__':
    for p in sys.argv[1:]:
        main(p)
        print()
