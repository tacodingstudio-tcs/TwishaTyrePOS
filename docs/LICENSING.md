# Licensing — everything about how Twisha POS is locked to one PC

Written 2026-10-26. This is the single reference for the license system. **No secret is in this file or in the repo.**

## What it does

The packaged (offline) app only runs on the PC its **license** was made for. A copy of the installer or of the installed folder
given to someone else shows an "activate" screen and does nothing else.

* A license is **one line of text**: `TWL1.<payload>.<signature>`.
  * payload (base64url JSON): `{ v:1, product, shop, machine, issued, expires }`
  * signature: Ed25519 over the payload text, made with the **private key** that only the software owner holds.
* The app contains only the **public key**, so it can verify a license but nobody can make one.
* A license names one **Machine ID**. On any other PC it fails with reason `machine`.
* It has an end date. Valid **through** the `expires` day; the day after, reason `expired`.

## Machine ID

Format `XXXXX-XXXXX-XXXXX-XXXXX` (20 hex chars of a SHA-256).
Input string: `twl1|<MachineGuid>|<SystemManufacturer>|<SystemProductName>|<BaseBoardProduct>` where
MachineGuid = `HKLM\SOFTWARE\Microsoft\Cryptography` and the other three are values under `HKLM\HARDWARE\DESCRIPTION\System\BIOS`.

Two implementations that must always agree:
* `apps/api/src/lib/machine-id.mjs` (used by the app; also `node apps/api/src/lib/machine-id.mjs` prints it)
* `tools/license/machine-id.ps1` (run on the customer's laptop *before* anything is installed)

The delivery folder `E:\softwares\_deliver\` holds `Get-Machine-ID.bat` + `Get-Machine-ID.ps1` for the customer: double-click the .bat,
a green `Machine ID: …` line appears and is copied to the clipboard.
Windows re-install changes MachineGuid -> a new license is needed. Replacing the laptop -> new license.

## Making a license (the owner does this)

```
node tools/license/make-license.mjs --key E:\softwares\_license-keys\private.pem ^
     --shop "Shakti Enterprise" --machine D8298-80DED-3A615-5A797 --expires 2027-11-01 --product tyre --out file.lic
```
`--days 365` instead of `--expires` counts from today. `--product` must match the product the license is for (see below).
The customer pastes the whole line into the app's activate screen (or you send the `.lic` file and they open it in Notepad).

### Licenses issued so far

| Shop | Product | Machine ID | Issued | Expires | File |
|---|---|---|---|---|---|
| Shakti Enterprise (Yogesh Mori, Veraval) | `tyre` | `D8298-80DED-3A615-5A797` | 2026-10-26 | 2027-11-01 | `E:\softwares\_deliver\Shakti-Enterprise.lic` |

Add a row for every license made. A renewal = a new license for the same Machine ID with a later `--expires`; pasting it replaces the old one.

## The signing key — custody

* Private key: **`E:\softwares\_license-keys\private.pem`** (created with `tools/license/make-keys.mjs`). It is **outside every repo and never
  put in an installer**. Whoever has it can issue licenses. **Back it up on an offline pen drive.** If it is lost, no license can be
  issued or renewed; the only fix would be a new key pair, a new build with the new public key, and re-licensing every customer.
* Public key: constant `LICENSE_PUBLIC_KEY` in `apps/api/src/lib/license.ts` (SPKI, base64). Changing it invalidates all existing licenses.
* `make-keys.mjs` refuses to overwrite an existing `private.pem`.

## How the app enforces it

* **Only when `LICENSE_REQUIRED=true`.** The packaged app's launcher (`deploy/offline/runtime/cli.mjs`, `services()`) sets it, plus
  `LICENSE_FILE=<data folder>\license.lic`. Development and the jest suites do not set it, so they run unlicensed.
* `apps/api/src/server.ts` has an `onRequest` hook: every `/api/*` call except `/api/license/*` gets **402**
  `{ error:'License required', code:'LICENSE_<REASON>', machineId }` until the PC is licensed. `/health` and the static web files are not gated.
* `apps/api/src/lib/license.ts`: `checkLicense(text)`, `licenseStatus()` (cached 20 s), `activateLicense(text)` (writes the file via tmp+rename).
  Reasons: `missing`, `invalid` (bad format / signature), `machine`, `expired`, `clock`, `product`.
* `apps/api/src/routes/license.ts` (public): `GET /api/license/status`, `POST /api/license/activate { license }` (422 if refused).
* **Clock roll-back guard:** `license.lic.seen` next to the license stores the newest date seen; if today is more than 1 day earlier, reason `clock`.
* **First-run exemption:** the installer's own script must create the shop before any license exists. `cli.mjs` sends header `x-setup-key`
  (sha256 of the installation's JWT secret + ":setup", first 32 hex) and passes the same value to the server as `LICENSE_SETUP_KEY`;
  the gate lets a request with that header through. Used only by `shop()`.
* Web: `apps/web/src/components/LicenseGate.tsx` wraps the whole app (`App.tsx`). Unlicensed -> a full-screen "activate" page showing the
  Machine ID (Copy button) and a box to paste the license. Licensed with 30 days or fewer left -> a thin amber banner.
  `apps/web/src/lib/api.ts` reloads once on a 402 `LICENSE_*` so the gate takes over.
* The product a license is for: `LICENSE_PRODUCT` in `license.ts` (`'tyre'`). A license for another product is refused (`product`).

## Testing it

* `cd apps/api && npx tsx scripts/license-selftest.ts` — makes sure a license for this PC verifies, another PC's reports `machine`,
  a tampered license / edited expiry report `invalid`. (It expects `$TEMP/mine.lic` made for this PC's Machine ID — make one with
  `make-license.mjs --machine <this PC's id> --days 30 --out %TEMP%\mine.lic`.)
* Packaged-app check (done 2026-10-26): start the bundle with its own data dir, `status` = `missing`, login = 402, activate = 200, login = 200,
  then a sale and its PDF work. First start creates the shop with no license (setup key).

## Honest limits

* It stops casual sharing (copied folder / installer on another PC). It does **not** stop a skilled developer who edits the app's code to
  remove the check: the server is a precompiled but readable JavaScript bundle (`_server.bundle.mjs`) plus node_modules.
* Planned hardening, not done: obfuscate the bundle, repeat the check in several places and in the C# launcher, per-customer builds with a
  visible license ID so a leak is traceable.
* Not done: optional online check-in (remote revoke / renewal reminders), trial period, per-customer installer watermark.

## Carrying it to another product (BuildMaterials POS)

The folder `E:\softwares\BuildMaterialsPOS` is a fork (steel / iron / paint / sand dealer). To license it: copy `license.ts`, `machine-id.mjs`,
`machine-id.d.mts`, `routes/license.ts`, the `server.ts` hook, `LicenseGate.tsx`, the `App.tsx` / `api.ts` changes and the launcher env,
set `LICENSE_PRODUCT = 'buildmaterials'`, and issue licenses with `--product buildmaterials`. The same key pair can sign both products.

## Related work done at the same time (2026-10-26)

* The desktop app signs out when its window is closed: web build flag `VITE_SESSION_ONLY=true` (set in `build-offline.mjs`) stores the session in
  `sessionStorage` (`apps/web/src/store/auth.store.ts`).
* Faster start-up: server precompiled by `deploy/offline/bundle-api.mjs` into `app/src/lib/_server.bundle.mjs` (must stay in `src/lib/` so the
  `../../assets/` paths resolve), Node compile cache (`NODE_COMPILE_CACHE`), one-time checks remembered in `<data>\startup-ok.json`, no
  `pg_ctl` launches to test if the database is up. Normal restart measured 4.6 s on the dev PC (was 6.8 s); the customer's laptop was taking 1-2 min.
* **Open decision:** an installer step that adds Windows Defender exclusions for the app and data folders (`SPEED-UP-START.ps1`) was written
  but the tooling blocked saving it; the owner chose to first measure on the customer's laptop by adding the two exclusions by hand
  (Windows Security > Exclusions > `%LOCALAPPDATA%\Programs\Twisha POS` and `%LOCALAPPDATA%\TwishaPOS`). Result not yet known.
