# CC's division, inverse and abs, as Sage's: _div_ is n = c^2 + d^2,
# p = c/n, q = d/n, (p a + q b) + (p b - q a) I; __invert__ is a/m, -b/m with
# m = a^2 + b^2; abs is sqrt(a^2 + b^2): each step rounded (Python's complex
# division and hypot round differently).  The parts are printed in hex, so
# each bit is compared; the operands are exact doubles, written in hex.
def h(v):
    return float(v.real()).hex() + " " + float(v.imag()).hex()

rows = [
    (float.fromhex('0x1.1001a66dc415fp+5'), float.fromhex('0x1.921f54cafdb44p-14'), float.fromhex('0x1.647555f3b2adap-28'), float.fromhex('0x1.a89bc440c1d25p-24')),
    (float.fromhex('-0x1.4388d4fe2a2f2p+20'), float.fromhex('0x1.b94eba917e776p-30'), float.fromhex('0x1.914c266dafb6bp-16'), float.fromhex('-0x1.85f4ff10724d0p-8')),
    (float.fromhex('0x1.f52fff07bedd2p-28'), float.fromhex('0x1.b77bc33600d48p-8'), float.fromhex('0x1.8ecb5ab2673e8p+18'), float.fromhex('-0x1.3d1625b93c498p+23')),
    (float.fromhex('-0x1.2020bdaaaf89ep-24'), float.fromhex('0x1.940ee14c4646dp+2'), float.fromhex('0x1.18db7534c30a0p+25'), float.fromhex('-0x1.ed50c8565fea0p+24')),
    (float.fromhex('0x1.37f3262f12ae0p+17'), float.fromhex('-0x1.c5e8390d5547ep+8'), float.fromhex('0x1.acc3457bea4cep-12'), float.fromhex('-0x1.cf220eb1c4bd4p+29')),
    (float.fromhex('0x1.5b60a2110bc02p+6'), float.fromhex('-0x1.7be3e329fd98cp+6'), float.fromhex('0x1.429f55be3a6e3p+16'), float.fromhex('-0x1.9b396a63a55c6p+10')),
    (float.fromhex('-0x1.613efb2f88630p-14'), float.fromhex('-0x1.71a289607c702p-20'), float.fromhex('-0x1.13194c2881060p+2'), float.fromhex('0x1.c8472ab9a8ecap-3')),
    (float.fromhex('0x1.eb2180184b310p-28'), float.fromhex('0x1.e63189549e09cp+8'), float.fromhex('0x1.ea1790d6a9755p+10'), float.fromhex('0x1.d45c0a60b622cp+6')),
    (float.fromhex('-0x1.361bffab1223dp-3'), float.fromhex('-0x1.2d3abb6f088b4p+28'), float.fromhex('-0x1.20bc8003263cep-22'), float.fromhex('0x1.8703c2ec8e37ep-24')),
    (float.fromhex('0x1.71a4c8e003b3bp+11'), float.fromhex('-0x1.6a007e8226363p-7'), float.fromhex('-0x1.43a5be2155a62p-22'), float.fromhex('-0x1.bd389ed05f80bp+23')),
    (float.fromhex('0x1.337e76990f058p+19'), float.fromhex('0x1.873d05ce83d16p+6'), float.fromhex('-0x1.b1edd1025cf10p-19'), float.fromhex('-0x1.ebfed17163e54p-9')),
    (float.fromhex('-0x1.e0a677b3e7d1cp-15'), float.fromhex('-0x1.60f464a3f0d40p-29'), float.fromhex('-0x1.4d7f9a21b97bcp+26'), float.fromhex('0x1.3d36d5b39ad7ap+27')),
    (float.fromhex('-0x1.8cc819328d616p+18'), float.fromhex('0x1.9e75f3db77347p+6'), float.fromhex('-0x1.901e160fb85a4p-9'), float.fromhex('-0x1.f4074ec3aac3ap-4')),
    (float.fromhex('0x1.5a8ee11d02ef0p-11'), float.fromhex('0x1.99004ba47807ap-26'), float.fromhex('-0x1.e73e5d0ec2ae2p+11'), float.fromhex('0x1.d2dbb82092746p-3')),
    (float.fromhex('-0x1.c817fe7941547p-12'), float.fromhex('0x1.809ced63a6f0ep+18'), float.fromhex('-0x1.5a290f797ae46p-9'), float.fromhex('-0x1.766a6740b9172p+7')),
    (float.fromhex('-0x1.abc27d2eb3fabp+30'), float.fromhex('0x1.fa2c8f88db703p+10'), float.fromhex('-0x1.f68ad331ed25ep-18'), float.fromhex('0x1.0a778458b29f7p-14')),
    (float.fromhex('0x1.623a62a230dfap+16'), float.fromhex('-0x1.e11316f0aae92p+15'), float.fromhex('0x1.898319b7d192ap+20'), float.fromhex('0x1.94160e29f96c0p-4')),
    (float.fromhex('-0x1.bb7c23343d95ep-25'), float.fromhex('-0x1.832c1bd9e456ap-11'), float.fromhex('0x1.f40a910aa5ef4p+4'), float.fromhex('0x1.d9e13f437b481p+22')),
    (float.fromhex('-0x1.dad64c13eae8bp+17'), float.fromhex('0x1.5c4ba5a19b9b6p-8'), float.fromhex('-0x1.ecfb7e2c8a189p+10'), float.fromhex('0x1.411c2046bd52fp-12')),
    (float.fromhex('-0x1.770a559b3bc36p+12'), float.fromhex('0x1.71fb95bdebe2ap+19'), float.fromhex('0x1.51448a3bac768p+13'), float.fromhex('-0x1.27c035b291b51p+0')),
    (float.fromhex('-0x1.070bcaad871c2p+25'), float.fromhex('0x1.852d5eae0318bp+9'), float.fromhex('0x1.4b41134347bd6p-11'), float.fromhex('-0x1.eef324856e932p-3')),
    (float.fromhex('0x1.7f5e0deda1c42p-15'), float.fromhex('0x1.50201791c0d8cp-29'), float.fromhex('0x1.db17ebfefcc24p+28'), float.fromhex('0x1.9df27e71ddb46p-19')),
    (float.fromhex('0x1.d0827c015e962p-19'), float.fromhex('-0x1.9fb6ab827e6c8p+1'), float.fromhex('0x1.0f6de5872e728p-1'), float.fromhex('-0x1.ee3e7393224f3p-5')),
    (float.fromhex('-0x1.9fdba6e4736d4p+17'), float.fromhex('-0x1.8f68b94c739cep-30'), float.fromhex('0x1.7fd3ef37bd4bap-1'), float.fromhex('0x1.bb0a3063eb642p+2')),
    (float.fromhex('0x1.1a23b622c0d04p+20'), float.fromhex('0x1.6975b2fe1c5ecp+26'), float.fromhex('-0x1.da1718d3c0d18p-19'), float.fromhex('0x1.79ce0f0e0e509p+8')),
    (float.fromhex('-0x1.653fb470c8d8cp+2'), float.fromhex('0x1.6ebd7a97f73edp+28'), float.fromhex('-0x1.50fea64cb52e6p+24'), float.fromhex('-0x1.21ec603e59b00p+15')),
    (float.fromhex('0x1.55437474cc4a4p+11'), float.fromhex('-0x1.40a3956f88e62p+20'), float.fromhex('-0x1.5b6e97bf09df4p-29'), float.fromhex('0x1.9fec9b1fe01dap-25')),
    (float.fromhex('-0x1.840b4f149c35bp-17'), float.fromhex('0x1.b698b11b7460cp+18'), float.fromhex('0x1.80044f7360ac6p-23'), float.fromhex('-0x1.497282f707402p-19')),
    (float.fromhex('0x1.b210ca47b8d2fp-5'), float.fromhex('0x1.01cfe412d9f82p+25'), float.fromhex('0x1.9beaed67872e2p+10'), float.fromhex('0x1.cd18f8d933064p-24')),
    (float.fromhex('0x1.107573e506c21p+7'), float.fromhex('-0x1.3d2e1b5b06c8ep+25'), float.fromhex('-0x1.1479084488ed6p+2'), float.fromhex('-0x1.b80217654b097p-26')),
    (float.fromhex('inf'), float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.0000000000000p+1'), float.fromhex('0x1.0000000000000p-1')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.0000000000000p+1'), float.fromhex('inf'), float.fromhex('0x0.0p+0')),
    (float.fromhex('-inf'), float.fromhex('-0x1.b200000000000p+7'), float.fromhex('0x1.8000000000000p+1'), float.fromhex('-0x1.0624dd2f1a9fcp-10')),
    (float.fromhex('nan'), float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.0000000000000p+1'), float.fromhex('0x1.8000000000000p+1')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x0.0p+0'), float.fromhex('-inf')),
    (float.fromhex('0x0.0p+0'), float.fromhex('-0x0.0p+0'), float.fromhex('0x1.8000000000000p+1'), float.fromhex('-0x1.0000000000000p+2')),
    (float.fromhex('-0x0.0p+0'), float.fromhex('-0x0.0p+0'), float.fromhex('0x1.0000000000000p+1'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x1.8000000000000p+0'), float.fromhex('0x0.0p+0'), float.fromhex('-0x1.0000000000000p+1'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x1.8000000000000p+0'), float.fromhex('-0x0.0p+0'), float.fromhex('0x0.0p+0'), float.fromhex('0x1.0000000000000p+1')),
    (float.fromhex('0x0.0p+0'), float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x0.0p+0'), float.fromhex('-0x0.0p+0')),
    (float.fromhex('0x1.0000000000000p+500'), float.fromhex('0x1.0000000000000p-500'), float.fromhex('0x1.8000000000000p+1'), float.fromhex('0x1.0000000000000p-300')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.0000000000000p-30'), float.fromhex('0x1.0000000000000p+400'), float.fromhex('0x1.0000000000000p+380')),
    ]
for a, b, c, d in rows:
    z, w = CC(a, b), CC(c, d)
    print(h(z / w), "|", h(~w), "|", float(w.abs()).hex(), "|", float(abs(w)).hex())

# a complex number keeps its parts in CC(), a -0.0 too
print(h(CC(CC(1, -0.0))), "|", h(CC(complex(1, -0.0))), "|", h(CC(-0.0)))
# 1/z and ~z: their zeros' signs differ, as in Sage
print(h(1 / CC(2, 0)), "|", h(~CC(2, 0)), "|", h(CC(1, 0) / CC(2, 0)))
