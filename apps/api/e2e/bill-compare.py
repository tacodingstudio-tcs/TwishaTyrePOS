# Compare a rendered bill with the same sheet exported by Excel itself (positions as a fraction of the bill width, font sizes, ...).
#   python e2e/bill-compare.py <excel-export.pdf> <our-bill.pdf>       (export the sheet with Excel: ExportAsFixedFormat; ours: npx tsx e2e/bill-preview.ts)
import sys, pymupdf

def info(path, label):
    d = pymupdf.open(path); p = d[0]
    segs = []
    for dr in p.get_drawings():
        for it in dr['items']:
            if it[0] == 'l':
                a, b = it[1], it[2]; segs.append((a.x, a.y, b.x, b.y))
            elif it[0] == 're':
                r = it[1]
                segs += [(r.x0, r.y0, r.x1, r.y0), (r.x0, r.y1, r.x1, r.y1), (r.x0, r.y0, r.x0, r.y1), (r.x1, r.y0, r.x1, r.y1)]
    hs = sorted({round(s[1], 1) for s in segs if abs(s[1] - s[3]) < 0.01 and abs(s[2] - s[0]) > 20})
    vs = sorted({round(s[0], 1) for s in segs if abs(s[0] - s[2]) < 0.01 and abs(s[3] - s[1]) > 3})
    spans = []
    for b in p.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                if s['text'].strip(): spans.append((s['text'].strip(), s['bbox'], s['size'], s['font']))
    return dict(p=p, h=hs, v=vs, spans=spans)

ex = info(sys.argv[1], 'excel'); us = info(sys.argv[2], 'ours')
# normalise: x by the table's left..right (outer box), y by the same factor from the first box line
def norm(i):
    xs = i['v']; x0, x1 = min(xs), max(xs); f = x1 - x0
    return x0, f
ex0, exf = norm(ex); us0, usf = norm(us)
print('table width pt  excel %.1f  ours %.1f   (ratio ours/excel %.4f)' % (exf, usf, usf / exf))
print('vertical lines (fraction of width):')
exv = [round((x - ex0) / exf, 4) for x in ex['v']]; usv = [round((x - us0) / usf, 4) for x in us['v']]
print(' excel', exv); print(' ours ', usv)
# horizontal lines relative to first line, in units of width
eh0 = ex['h'][0]; uh0 = us['h'][0]
print('horizontal lines (fraction of width from the first line):')
print(' excel', [round((y - eh0) / exf, 4) for y in ex['h']])
print(' ours ', [round((y - uh0) / usf, 4) for y in us['h']])
print('text spans: label | excel x,y,size | ours x,y,size   (x,y as fraction of width; y from first line)')
def key(t): return t
um = {}
for t, bb, sz, fn in us['spans']: um.setdefault(t, []).append((bb, sz, fn))
for t, bb, sz, fn in ex['spans']:
    o = um.get(t)
    ex_xy = ((bb[0] - ex0) / exf, (bb[3] - eh0) / exf)
    if not o: print('  %-28s excel (%.3f,%.3f) %.1fpt %s | ours: MISSING' % (t[:28], ex_xy[0], ex_xy[1], sz, fn)); continue
    ob = o[0]; os_ = ((ob[0][0] - us0) / usf, (ob[0][3] - uh0) / usf)
    flag = '' if abs(ex_xy[0] - os_[0]) < 0.004 and abs(ex_xy[1] - os_[1]) < 0.004 else '   <<<'
    print('  %-28s excel (%.3f,%.3f) %5.2f | ours (%.3f,%.3f) %5.2f  size ratio %.3f%s' % (t[:28], ex_xy[0], ex_xy[1], sz, os_[0], os_[1], ob[1], (ob[1] / usf) / (sz / exf), flag))
