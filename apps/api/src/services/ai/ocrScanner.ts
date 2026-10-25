// apps/api/src/services/ai/ocrScanner.ts
//
// Photo of a supplier bill -> structured purchase entry.
// Uses Claude's vision capability (Sonnet, not Haiku — vision needs the
// larger model). Output is validated through the same defensive pattern
// as the other AI helpers: Zod schema, graceful failure, never trusted for
// final amounts without the rule engine confirming GST math.
//
// Flow:
//   1. Image (base64) -> Claude vision -> structured JSON
//   2. Zod validates shape
//   3. Entity resolution: match extracted item names to existing products
//      (new products get flagged for manual creation, not auto-created)
//   4. Match supplier name to existing party (or flag as new supplier)
//   5. Return a draft purchase_invoice for human review before saving

import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { OCRBillSchema, type OCRBill } from './extraction.schemas.js'

const OCR_SYSTEM_PROMPT = `You are reading a photo of a supplier invoice/bill
for an Indian small business. Extract all information as structured JSON.

Return ONLY valid JSON matching this exact shape, nothing else:

{
  "supplierName": "name of the company/shop that issued this bill, or null",
  "supplierGstin": "15-character GSTIN if visible, or null",
  "billNo": "invoice/bill number if visible, or null",
  "billDate": "YYYY-MM-DD if confidently readable, or null",
  "items": [
    {
      "name": "product/item name exactly as printed",
      "qty": number,
      "unit": "kg|pcs|box|ltr|etc — use what's printed or infer reasonably",
      "rate": number (per-unit price),
      "hsnCode": "HSN code if printed, or null",
      "gstRate": one of [0,5,12,18,28] if shown, or null if not visible,
      "total": number (line total if printed, or null)
    }
  ],
  "grandTotal": number if visible, or null,
  "confidence": 0.0 to 1.0 — your overall confidence in this extraction
}

RULES:
- If handwriting is illegible, lower confidence and do your best guess —
  never refuse to extract.
- If a quantity or rate is genuinely unreadable, omit that item rather
  than guessing wildly, and mention it would need manual entry.
- Indian bills often print MRP separately from rate — extract the actual
  billed rate, not MRP, when both are shown.
- Numbers may use Indian formatting (1,00,000 = 100000) — parse correctly.`

// =============================================================================
// scanBillImage
// =============================================================================
export async function scanBillImage(
  imageBase64: string,
  mediaType:   'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg'
): Promise<OCRBill> {
  const rawText = await ai.vision({
    system:      OCR_SYSTEM_PROMPT,
    prompt:      'Extract this bill as JSON per the schema in your instructions.',
    imageBase64,
    mediaType,
    maxTokens:   2048,
    quality:     'best',
  })

  let parsed: unknown
  try {
    parsed = parseAIJson(rawText) ?? JSON.parse('{}')
    if (!parsed) throw new Error('empty')
  } catch {
    throw Object.assign(
      new Error('Could not read this bill image — try a clearer photo'),
      { statusCode: 422, code: 'OCR_PARSE_FAILED' }
    )
  }

  const result = OCRBillSchema.safeParse(parsed)
  if (!result.success) {
    throw Object.assign(
      new Error('Bill image was read but did not contain valid line items'),
      { statusCode: 422, code: 'OCR_VALIDATION_FAILED', issues: result.error.flatten() }
    )
  }

  return result.data
}
