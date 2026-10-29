"""Reads the payment QR out of bill PDFs (what a phone camera would do) and prints the link inside it.
   python e2e/bill-qr-decode.py <folder with the PDFs> [name ...]      e.g.  e2e-out/qrbills car credit memo
   Also writes <name>.png (page 1, 100 dpi) next to each PDF so the bill can be looked at."""
import os
import sys

import cv2
import fitz
import numpy as np

folder = sys.argv[1]
names = sys.argv[2:] or ['car', 'credit', 'memo', 'quotation']
for n in names:
    d = fitz.open(os.path.join(folder, n + '.pdf'))
    page = d[-1] if len(d) > 1 else d[0]
    pix = page.get_pixmap(dpi=220)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    print(n.ljust(10), 'pages', len(d), '|', text or 'no QR')
    page.get_pixmap(dpi=100).save(os.path.join(folder, n + '.png'))
