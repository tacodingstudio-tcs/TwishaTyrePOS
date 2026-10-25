# Dumps the layout of the shop Excel bill book (columns, rows, borders, fonts) straight from the .xlsx — what tyre-bill-shakti.ts reproduces.
#   python e2e/bill-sheet-dump.py <bill.xlsx> [sheet2|sheet4]    (sheet2 = Car Bill, sheet4 = 2 Wheel Bill)
import zipfile, re, sys
from xml.etree import ElementTree as ET
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
z = zipfile.ZipFile(sys.argv[1])
ss = []
if 'xl/sharedStrings.xml' in z.namelist():
    r = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in r.findall('m:si', NS):
        ss.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
st = ET.fromstring(z.read('xl/styles.xml'))
fonts = []
for f in st.find('m:fonts', NS):
    sz = f.find('m:sz', NS); nm = f.find('m:name', NS)
    fonts.append((nm.get('val') if nm is not None else '?', float(sz.get('val')) if sz is not None else 0, f.find('m:b', NS) is not None, f.find('m:u', NS) is not None, f.find('m:i', NS) is not None))
xfs = []
for xf in st.find('m:cellXfs', NS):
    al = xf.find('m:alignment', NS)
    xfs.append(dict(font=int(xf.get('fontId', 0)), border=int(xf.get('borderId', 0)), fill=int(xf.get('fillId', 0)), numFmt=xf.get('numFmtId'),
                    h=al.get('horizontal') if al is not None else None, v=al.get('vertical') if al is not None else None, wrap=al.get('wrapText') if al is not None else None))
borders = []
for b in st.find('m:borders', NS):
    d = {}
    for side in ('left', 'right', 'top', 'bottom'):
        e = b.find('m:' + side, NS)
        d[side] = e.get('style') if e is not None and e.get('style') else None
    borders.append(d)
fills = []
for f in st.find('m:fills', NS):
    pf = f.find('m:patternFill', NS); fg = pf.find('m:fgColor', NS) if pf is not None else None
    fills.append((pf.get('patternType') if pf is not None else None, dict(fg.attrib) if fg is not None else None))

which = sys.argv[2] if len(sys.argv) > 2 else 'sheet2'
sh = ET.fromstring(z.read('xl/worksheets/%s.xml' % which))
print('== ', which)
for tag in ('sheetPr', 'dimension', 'sheetFormatPr', 'pageMargins', 'pageSetup', 'printOptions', 'headerFooter'):
    e = sh.find('m:' + tag, NS)
    if e is not None: print(tag, e.attrib, [c.attrib for c in e])
print('cols:', [(c.get('min'), c.get('max'), round(float(c.get('width')), 2), c.get('hidden')) for c in sh.find('m:cols', NS)])
rows = sh.find('m:sheetData', NS)
print('merges:', [m.get('ref') for m in (sh.find('m:mergeCells', NS) if sh.find('m:mergeCells', NS) is not None else [])])
print('fonts used:', fonts)
for row in rows:
    r = row.get('r'); ht = row.get('ht'); cells = []
    for c in row:
        ref = c.get('r'); s = int(c.get('s', 0)); t = c.get('t'); v = c.find('m:v', NS); f = c.find('m:f', NS)
        val = None
        if v is not None: val = ss[int(v.text)] if t == 's' else v.text
        x = xfs[s]; b = borders[x['border']]; bd = ''.join(k[0].upper() + ('!' if b[k] in ('medium', 'thick') else '') for k in b if b[k])
        fo = fonts[x['font']]
        if val is not None or f is not None or bd:
            cells.append('%s[%s|%s%s%s|%s%s%s]%s' % (ref, (val or '')[:26] if val else ('=' + (f.text or '')[:24] if f is not None else ''), fo[0][:4], int(fo[1]), 'B' if fo[2] else '', x['h'] or '', ('/' + x['v']) if x['v'] else '', ('/wrap' if x['wrap'] else ''), (' ' + bd) if bd else ''))
    print('row', r, 'ht=', ht, ' '.join(cells))
