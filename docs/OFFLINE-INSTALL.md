# Shakti Enterprise — offline installation on Yogesh's laptop

Everything runs on the laptop itself: no internet, no server, no monthly cost. One file to install, one icon to click.

* Shop: **Shakti Enterprise** — owner **Yogesh Mori**
* Sign in with mobile **9227575750**, PIN **7575** (only this one login exists on this laptop)
* Bill numbers continue from the paper book: cars from **93**, two-wheelers from **2W-4**

---

## A. Before you go (on your own computer)

1. Copy **`Shakti-Enterprise-Setup.exe`** to a pen drive (about 95 MB; it contains the database, the app and the logo).
2. Also copy this guide, and (optional) the shop's tyre list as an Excel file for importing.

## B. On Yogesh's laptop — one step at a time

Do each step, check the "You should see" line, then move to the next.

### Step 1 — Check the laptop (2 minutes)

* Windows 10 or 11, **64-bit** (Settings → System → About → "System type: 64-bit").
* At least **2 GB** free on drive C: (the app itself is ~450 MB; data grows slowly).
* **Do not** right-click anything and choose "Run as administrator" — the installer does not need it and the database refuses to run that way.

> You should see: nothing to do yet — just confirm the three points above.

### Step 2 — Copy and start the installer

1. Plug in the pen drive, copy `Shakti-Enterprise-Setup.exe` to the Desktop, double-click it.
2. Windows may show a blue box **"Windows protected your PC"** (the installer is not code-signed). Click **More info** → **Run anyway**.
3. Click **Next** → leave the folder as it is → tick **"Put a Shakti Enterprise icon on the desktop"** → **Install**.
4. Wait for the green bar (about a minute). Leave **"Start Shakti Enterprise now"** ticked → **Finish**.

> You should see: a small window "Shakti Enterprise — Starting…" with lines like *Checking this laptop*, *Preparing the database*, *Starting the database, job store and app*, *Creating the shop and its login*. The first start takes about **10–20 seconds** (a few seconds more if the antivirus is scanning).

### Step 3 — The first screen

* The window closes by itself and the app opens in its own window (Microsoft Edge, no address bar).
* Sign in: mobile **9227575750**, PIN **7575**.

> You should see: the **Home** screen with *Shakti Enterprise* and the Shakti round logo at the top left.

If the window says **"Could not start"** — read the last lines, click **Try again**. Common causes are in section F.

### Step 4 — Put the tyres in (once)

1. Menu → **Tyre Stock** → *Import* (or **Tyres & Items** → *Import*) → **Download the template**, fill it in Excel (brand, size, price, GST %, stock), save.
2. *Choose Excel / CSV file* → **Check** (nothing is saved yet) → **Import**.
3. Customers: **Customers** → **Import** (same idea: Name, Mobile, GST No …).

### Step 5 — Make the first real bill (and check it)

1. **New Sale** → choose the bill book (**Car** or **Two wheel**) → add the customer → search the tyre by size → tap it → **Save bill**.
2. Open the bill → **PDF** / **Print**.

> You should see: the bill with **SHAKTI ENTERPRISE**, the logo, address, GST No. 24AFTFS9416C1ZP, and the number **93** (first car bill) or **2W-4** (first two-wheeler bill).

### Step 6 — Daily use

* **Start of day:** double-click **Shakti Enterprise** on the desktop. (Tick "start automatically" in the installer if you want it to start with Windows.)
* While it runs there is a small icon near the clock (bottom right; click the **^** arrow if hidden). Right-click it:
  * **Open Shakti Enterprise** — brings the window back if it was closed
  * **Back up now**
  * **Show status**
  * **Quit (stop and back up)** — use this at the end of the day
* Closing the app window does **not** stop the program; it keeps running quietly. Use **Quit** from the icon at night, or just shut Windows down normally (it stops itself and backs up).

### Step 7 — Backups (very important)

* A backup is taken automatically every time you **Quit**, and whenever you click **Back up now**.
* Backups are in **Documents → TwishaPOS Backups** (the last 30 are kept).
* **Once a week copy that folder to a pen drive** (or Google Drive / email to yourself). A laptop can be lost or broken; a backup on the same laptop does not help then.

### Step 8 — If something goes wrong

| Problem | What to do |
|---|---|
| "Could not start — port … is used by another program" | Restart the laptop and start again. If it keeps happening, tell me the number shown. |
| Forgot the PIN | Start menu → **Shakti Enterprise** → **Forgot the PIN** → type a new 4-digit PIN. |
| "Too many wrong PINs — locked for 15 minutes" | Start menu → **Shakti Enterprise** → **Sign-in locked? Unlock**. |
| Laptop switched off suddenly / power cut | Just start the app again — it repairs itself (first start may take up to a minute). Nothing already saved is lost. |
| The app window shows "can't reach this page" | The program is not running. Double-click the desktop icon. |
| Need to go back to an earlier day | Start menu → **Restore a backup** → follow the instructions (this replaces everything with the chosen backup). |
| Antivirus deletes or blocks a file | Open the antivirus → allow / restore it, and add the folder `%LocalAppData%\Programs\Shakti Enterprise` to its exclusions. |

### Step 9 — Updating later

Run the newer `Shakti-Enterprise-Setup.exe` over the old one. It stops the app, takes a backup, replaces the program files and **keeps all data**.

### Step 10 — Uninstall (only if needed)

Settings → Apps → *Shakti Enterprise* → Uninstall. **The shop data and backups are not deleted** (they live in `%LocalAppData%\TwishaPOS` and Documents → TwishaPOS Backups).

---

## C. The one-by-one method (if the installer will not run)

The installer folder also contains numbered files. Open **`%LocalAppData%\Programs\Shakti Enterprise`** and double-click in this order, checking each result before the next:

1. `1-CHECK-LAPTOP.bat` — checks Windows, disk space and free ports
2. `2-SETUP-DATABASE.bat` — creates the database
3. `3-START-SERVICES.bat` — starts the database and the app
4. `4-CREATE-SHOP-AND-LOGIN.bat` — creates the shop and the one login
5. `5-OPEN-APP.bat` — opens the app

Other helpers: `STATUS.bat`, `BACKUP-NOW.bat`, `STOP-TWISHA-POS.bat`, `UNLOCK-LOGIN.bat`, `FORGOT-PIN.bat`, `RESTORE-BACKUP.bat`.
(In this method the black windows stay open while it works — that is normal.)

## D. Where things are

| What | Where |
|---|---|
| Program | `%LocalAppData%\Programs\Shakti Enterprise` |
| Shop data (database) | `%LocalAppData%\TwishaPOS` |
| Backups | Documents → `TwishaPOS Backups` |
| Logs (for me, if something fails) | `%LocalAppData%\TwishaPOS\logs` — send `setup.log` and `api.log` |

(`%LocalAppData%` = `C:\Users\<name>\AppData\Local`. Type it in the File Explorer address bar.)

## E. What is and is not included

* Included: billing (car + two-wheeler bill book layout), quotations, stock, customers, warranty and claims, vehicles and reminders, team and salary (with overtime), expenses, GST reports, Excel export for the CA, PDF/print.
* Needs the internet (optional): WhatsApp messages. Everything else works with the internet off.
* Only one login (Yogesh). To add staff logins later, ask me — it is switched off on purpose in this install.

## F. Notes for me (support)

* First start can take longer on laptops with aggressive antivirus: Windows scans each new program the first time it runs (the job-store program, Redis, was seen taking 30–70 s to open its port on a dev PC). The app does **not** wait for it.
* Everything is self-contained: Node 22, PostgreSQL 16, Redis 7.2, the app and the screens. Ports used: 4470 (app), 54329 (database), 63790 (job store) — all on 127.0.0.1 only; nothing is reachable from the network.
* Tested here on a clean copy: start (6–8 s), sign in, bill with PDF, hard kill (power-cut) + restart with no data lost, stop with backup, restore.
