# parse_lnk.py - 解析 .lnk（MS-SHLLINK）二进制结构，重点 dump LinkTargetIDList
import struct, sys

def hexdump(b, maxlen=96):
    h = b[:maxlen].hex()
    if len(b) > maxlen:
        h += '...(%d bytes total)' % len(b)
    return h

def try_utf16_tail(b):
    # IDList 文件系统条目的名字通常在条目尾部（UTF-16LE + null），尝试提取可读尾巴
    if len(b) % 2 == 1:
        b = b + b'\x00'
    chars = []
    for i in range(len(b) - 2, -1, -2):
        c = b[i:i+2]
        if c == b'\x00\x00':
            break
        try:
            ch = c.decode('utf-16-le')
        except Exception:
            return ''
        if not (ch.isprintable() or ch in ' /\\'):
            return ''
        chars.append(ch)
    return ''.join(reversed(chars))

def parse(path):
    data = open(path, 'rb').read()
    print('=' * 72)
    print('%s  (%d bytes)' % (path, len(data)))
    hdrsz, = struct.unpack_from('<I', data, 0)
    clsid = data[4:20]
    flags, attrs = struct.unpack_from('<II', data, 20)
    print('  HeaderSize=%d  LinkCLSID=%s  LinkFlags=0x%04X  FileAttrs=0x%X'
          % (hdrsz, clsid.hex(), flags, attrs))
    assert clsid[:4] == b'\x01\x14\x02\x00', 'not a shell link CLSID'
    off = hdrsz
    if flags & 0x01:
        start = off
        items = []
        while True:
            isz, = struct.unpack_from('<H', data, off)
            if isz == 0:
                off += 2
                break
            items.append(data[off:off + isz])
            off += isz
        print('  [IDList] total=%d bytes, %d items' % (off - start, len(items)))
        for i, it in enumerate(items):
            body = it[2:]
            print('    item[%d] size=%d  hex=%s' % (i, len(it), hexdump(it)))
            tail = try_utf16_tail(body)
            if tail:
                print('            utf16-tail=%r' % tail)
    else:
        print('  [IDList] ABSENT')
    if flags & 0x02:
        lisz, hs, liflags, voloff, lbpoff, cnr, cps = struct.unpack_from('<IIIIIII', data, off)
        print('  [LinkInfo] size=%d hdrsz=%d flags=0x%X volOff=%d lbpOff=%d'
              % (lisz, hs, liflags, voloff, lbpoff))
        if lbpoff:
            lbp = data[off + lbpoff:].split(b'\x00')[0]
            print('             LocalBasePath=%r' % lbp)
        off += lisz
    order = []
    if flags & 0x04: order.append('NAME')
    if flags & 0x08: order.append('REL_PATH')
    if flags & 0x10: order.append('WORKING_DIR')
    if flags & 0x20: order.append('ARGS')
    if flags & 0x40: order.append('ICON_LOCATION')
    for name in order:
        cnt, = struct.unpack_from('<H', data, off)
        off += 2
        s = data[off:off + cnt * 2]
        off += cnt * 2
        print('  [StringData] %-14s = %r' % (name, s.decode('utf-16-le', 'replace')))
    print('  consumed=%d / %d  %s' % (off, len(data), 'OK' if off == len(data) else 'MISMATCH!'))

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            parse(p)
        except Exception as e:
            print('%s  ERROR: %s' % (p, e))
