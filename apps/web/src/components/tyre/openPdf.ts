import toast from 'react-hot-toast'
import { tyreApi, apiError } from '@/lib/api'

/**
 * Fetches a server-rendered PDF with the user's token and sends it straight to the print dialog (no tab to open and
 * Ctrl+P). If the browser will not print from a hidden frame, it falls back to opening the PDF so it can be printed from there.
 */
export async function printPdf(path: string, filename: string): Promise<void> {
  const t = toast.loading('Preparing bill…')
  try {
    const blob = await tyreApi.pdfBlob(path)
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    frame.src = url
    let done = false
    const finish = () => { if (done) return; done = true; setTimeout(() => { frame.remove(); URL.revokeObjectURL(url) }, 60_000) }
    frame.onload = () => {
      try { frame.contentWindow?.focus(); frame.contentWindow?.print(); toast.dismiss(t) }
      catch { window.open(url, '_blank'); toast.dismiss(t) }
      finish()
    }
    document.body.appendChild(frame)
    setTimeout(() => { if (!done) { toast.dismiss(t); window.open(url, '_blank'); finish() } }, 8000)   // the frame never loaded
    void filename
  } catch (e) {
    toast.error(apiError(e), { id: t })
  }
}

/** Fetches a server-rendered PDF with the user's token and opens it in a new tab (or downloads if popups are blocked). */
export async function openPdf(path: string, filename: string): Promise<void> {
  const t = toast.loading('Preparing PDF…')
  // Open the tab NOW, while the click is still "fresh": a tab opened after the download finishes is treated as a pop-up
  // and blocked. The tab shows a short message, then moves to the PDF.
  const win = window.open('', '_blank')
  try { win?.document.write('<title>Preparing PDF…</title><body style="font-family:sans-serif;color:#555;padding:2rem">Preparing your PDF…</body>') } catch { /* cross-origin guard */ }
  try {
    const blob = await tyreApi.pdfBlob(path)
    const url = URL.createObjectURL(blob)
    if (win && !win.closed) win.location.href = url
    else {                                     // pop-ups are blocked: save the file instead
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
    toast.dismiss(t)
  } catch (e) {
    win?.close()
    toast.error(apiError(e), { id: t })
  }
}
