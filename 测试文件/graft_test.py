# graft_test.py - 差分实验：把"正统 .lnk 的 IDList"嫁接到"我们生成的 .lnk"上，
# 点火后若能启动（会打开 Dev-C++），说明我们的 IDList 是病根；
# 若仍报 ERROR_NO_ASSOCIATION，说明病根在 LinkInfo/StringData/头。
import struct, sys

def parse_full(path):
    data = open(path, 'rb').read()
    hdrsz, = struct.unpack_from('<I', data, 0)
    flags, = struct.unpack_from('<I', data, 20)
    off = hdrsz
    start = off
    while True:
        isz, = struct.unpack_from('<H', data, off)
        if isz == 0:
            off += 2
            break
        off += isz
    idlist = data[start:off]
    lisz, = struct.unpack_from('<I', data, off)
    linkinfo = data[off:off + lisz]
    off += lisz
    rest = data[off:]
    header = data[:hdrsz]
    return header, idlist, linkinfo, rest

ours = parse_full(sys.argv[1])
real = parse_full(sys.argv[2])
out = ours[0] + real[1] + ours[2] + ours[3]
open(sys.argv[3], 'wb').write(out)
print('grafted: our_header(%d) + real_IDList(%d) + our_LinkInfo(%d) + our_rest(%d) = %d bytes -> %s'
      % (len(ours[0]), len(real[1]), len(ours[2]), len(ours[3]), len(out), sys.argv[3]))
