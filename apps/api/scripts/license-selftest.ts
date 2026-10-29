import fs from 'node:fs'
import { checkLicense } from '../src/lib/license.js'
const mine = fs.readFileSync(process.env['TEMP'] + '/mine.lic', 'utf8')
const his = fs.readFileSync('E:/softwares/tyrePOS-build-tools/_deliver/Shakti-Enterprise.lic', 'utf8')
console.log('this PC license  →', JSON.stringify(checkLicense(mine)).slice(0, 90))
console.log("Yogesh's license here →", JSON.stringify(checkLicense(his)).slice(0, 60))
console.log('tampered →', JSON.stringify(checkLicense(mine.replace('TWL1.', 'TWL1.A'))).slice(0, 60))
const [a, b, c] = mine.trim().split('.'); const p = JSON.parse(Buffer.from(b, 'base64url').toString()); p.expires = '2099-01-01'
console.log('edited expiry →', JSON.stringify(checkLicense([a, Buffer.from(JSON.stringify(p)).toString('base64url'), c].join('.'))))
