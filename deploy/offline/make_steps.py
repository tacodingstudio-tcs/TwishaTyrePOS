"""Generates the numbered .bat step files (run once; the output is committed in deploy/offline/steps)."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "steps")
os.makedirs(OUT, exist_ok=True)
NODE = '"%~dp0node\\node.exe" "%~dp0scripts\\cli.mjs"'

steps = {
    "1-CHECK-LAPTOP.bat": ("Step 1 of 5 - Check this laptop", "check", "Step 1 done. Next: double-click 2-SETUP-DATABASE.bat"),
    "2-SETUP-DATABASE.bat": ("Step 2 of 5 - Set up the database", "db", "Step 2 done. Next: double-click 3-START-SERVICES.bat"),
    "3-START-SERVICES.bat": ("Step 3 of 5 - Start the services", "services", "Step 3 done. Next: double-click 4-CREATE-SHOP-AND-LOGIN.bat"),
    "4-CREATE-SHOP-AND-LOGIN.bat": ("Step 4 of 5 - Create the shop and the login", "shop", "Step 4 done. Next: double-click 5-OPEN-APP.bat"),
    "5-OPEN-APP.bat": ("Step 5 of 5 - Open Twisha POS", "open", "Twisha POS is open. Sign in with the owner mobile number and PIN."),
    "START-TWISHA-POS.bat": ("Twisha POS - start everything", "start", "Twisha POS is running. Use STOP-TWISHA-POS.bat when you finish for the day."),
    "STOP-TWISHA-POS.bat": ("Twisha POS - stop (with a backup)", "stop", "Stopped. Your data and the backup are safe."),
    "BACKUP-NOW.bat": ("Twisha POS - back up now", "backup", "Backup saved in Documents\\TwishaPOS Backups. Copy that folder to a pen drive now and then."),
    "STATUS.bat": ("Twisha POS - status", "status", "OK"),
    "UNLOCK-LOGIN.bat": ("Twisha POS - lift the sign-in lock", "unlock", "Done. Try signing in again."),
}


def write(name, lines):
    with open(os.path.join(OUT, name), "w", newline="\r\n") as f:
        f.write("\n".join(lines) + "\n")


for name, (title, cmd, done) in steps.items():
    write(name, [
        "@echo off", f"title {title}", 'cd /d "%~dp0"', "echo.",
        f"{NODE} {cmd}", "echo.",
        f"if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   {done} )",
        "echo.", "pause",
    ])

write("FORGOT-PIN.bat", [
    "@echo off", "title Twisha POS - set a new PIN", 'cd /d "%~dp0"', "echo.",
    "set /p NEWPIN=Type the NEW 4-digit PIN and press Enter: ",
    f"{NODE} reset-pin %NEWPIN%", "echo.", "pause",
])
write("RESTORE-BACKUP.bat", [
    "@echo off", "title Twisha POS - restore a backup", 'cd /d "%~dp0"', "echo.",
    "echo   This REPLACES everything in Twisha POS with the backup you choose.", "echo.",
    f"{NODE} restore", "echo.",
    "set /p FILE=Paste the full path of the backup file (from the list above) and press Enter: ",
    "set /p SURE=Type YES to replace everything with that backup: ",
    f'if /i "%SURE%"=="YES" {NODE} restore "%FILE%" --yes', "echo.", "pause",
])
print(sorted(os.listdir(OUT)))
