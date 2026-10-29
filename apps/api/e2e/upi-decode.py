"""Reads the QR out of a screenshot (what a phone camera would do) and prints the payment link inside it.
   python e2e/upi-decode.py e2e-out/upi/1400x900.png [expected amount, e.g. 8024.00]"""
import sys
import cv2

img = cv2.imread(sys.argv[1])
if img is None:
    sys.exit('cannot read ' + sys.argv[1])
text = ''
for scale in (1, 2, 3):
    big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else img
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(big)
    if text:
        break
print(text or 'NO QR FOUND')
if len(sys.argv) > 2:
    ok = ('am=' + sys.argv[2]) in text
    print('amount matches' if ok else 'AMOUNT DIFFERS')
    sys.exit(0 if ok else 1)
sys.exit(0 if text else 1)
