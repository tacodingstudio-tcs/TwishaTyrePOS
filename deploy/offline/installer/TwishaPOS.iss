; Inno Setup script for the offline Twisha POS installer.
; Built by deploy\offline\build-offline.mjs:   ISCC.exe /DSrcDir=<bundle folder> /DOutDir=<where> TwishaPOS.iss
; Per-user install: no administrator rights, nothing written outside the user's own folders.

#ifndef SrcDir
  #error SrcDir (the bundle folder) is required
#endif
#ifndef OutDir
  #define OutDir "."
#endif
#ifndef AppVer
  #define AppVer "1.0.0"
#endif

#ifdef TestMode
  ; a throw-away installer for tests: its own AppId / name, no desktop or Start-menu icons, so it can never touch the real installation
  #define AppName "Twisha POS (installer test)"
  #define AppGuid "{{0F3A91D2-5C44-4C0B-8E21-7D6A3B9E1F10}"
#else
  #define AppName "Twisha POS"
  #define AppGuid "{{6C2E0D8A-7B1F-4F5E-9A3C-5A1D2E7B9C41}"
#endif

[Setup]
AppId={#AppGuid}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Twisha Consultancy Services
DefaultDirName={localappdata}\Programs\Twisha POS
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=Twisha-POS-Setup
SetupIconFile={#SrcDir}\twisha.ico
UninstallDisplayIcon={app}\TwishaPOS.exe
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
AppMutex=
CloseApplications=no
; the database and the backups are NOT inside the program folder, so an uninstall / re-install never touches the shop's data

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start Twisha POS automatically when I sign in to Windows"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; the window-less helper that ends the old programs before files are replaced (see TwishaKill.cs); unpacked to a temp folder, so an old copy needs no update to use it
Source: "{#SrcDir}\TwishaKill.exe"; Flags: dontcopy

#ifndef TestMode
[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\TwishaPOS.exe"; WorkingDir: "{app}"; Comment: "Start Twisha POS"
Name: "{autodesktop}\{#AppName} Backup"; Filename: "{app}\Backup.exe"; WorkingDir: "{app}"; Comment: "Back up the shop data, and choose where backups go"
Name: "{group}\{#AppName}"; Filename: "{app}\TwishaPOS.exe"; WorkingDir: "{app}"
Name: "{group}\{#AppName} Backup (choose where)"; Filename: "{app}\Backup.exe"; WorkingDir: "{app}"
Name: "{group}\Back up now (no questions)"; Filename: "{app}\Backup.exe"; Parameters: "--now"; WorkingDir: "{app}"
Name: "{group}\Stop Twisha POS"; Filename: "{app}\TwishaPOS.exe"; Parameters: "--stop"; WorkingDir: "{app}"
Name: "{group}\Show status"; Filename: "{app}\TwishaPOS.exe"; Parameters: "--status"; WorkingDir: "{app}"
Name: "{group}\Sign-in locked - Unlock"; Filename: "{app}\UNLOCK-LOGIN.bat"; WorkingDir: "{app}"
Name: "{group}\Forgot the PIN"; Filename: "{app}\FORGOT-PIN.bat"; WorkingDir: "{app}"
Name: "{group}\Restore a backup"; Filename: "{app}\RESTORE-BACKUP.bat"; WorkingDir: "{app}"
Name: "{group}\Open the backups folder"; Filename: "{userdocs}\TwishaPOS Backups"
Name: "{userstartup}\{#AppName}"; Filename: "{app}\TwishaPOS.exe"; WorkingDir: "{app}"; Tasks: autostart
#endif

[Run]
Filename: "{app}\TwishaPOS.exe"; Description: "Start Twisha POS now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\TwishaPOS.exe"; Parameters: "--stop"; WorkingDir: "{app}"; RunOnceId: "StopTwishaPOS"; Flags: waituntilterminated

[Code]
var
  BackupTaken: Boolean;

// Where the shop's data lives (TWISHA_DATA is only set by the installer tests).
function DataDir(): String;
begin
  Result := GetEnv('TWISHA_DATA');
  if Result = '' then Result := ExpandConstant('{localappdata}\TwishaPOS');
end;

function HasShopData(): Boolean;
begin
  Result := FileExists(DataDir() + '\pg-data\PG_VERSION');
end;

// Ends every program that runs from the install folder (database, job store, app server, tray icon) so Windows lets the files be replaced.
// TwishaKill.exe has no window; a hidden PowerShell / cmd here opens a terminal window on laptops where Windows Terminal is the default.
procedure KillProgramsInInstallFolder();
var
  code: Integer;
  dir: String;
begin
  dir := ExpandConstant('{app}');
  if not DirExists(dir) then Exit;
  ExtractTemporaryFile('TwishaKill.exe');
  Exec(ExpandConstant('{tmp}\TwishaKill.exe'), '"' + dir + '"', '', SW_HIDE, ewWaitUntilTerminated, code);
  Sleep(1000);
end;

// An upgrade over a running copy: stop it first, so no file is in use.
procedure StopRunningCopy();
var
  exe: String;
  code: Integer;
begin
  exe := ExpandConstant('{app}\TwishaPOS.exe');
  if FileExists(exe) then
    Exec(exe, '--stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, code);
  // Anything of Twisha POS that is still running (the database server keeps its runtime DLLs open, and the app may have been started
  // again at sign-in) would make Windows refuse to replace those files - "DeleteFile failed; code 5".
  KillProgramsInInstallFolder();
end;

// The shop's data is never inside the program folder, so an update cannot touch it - but a backup is taken first anyway, and if it cannot be
// taken the installation stops before anything is changed.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  exe: String;
  code: Integer;
begin
  Result := '';
  exe := ExpandConstant('{app}\TwishaPOS.exe');
  if HasShopData() and FileExists(exe) then
  begin
    WizardForm.PreparingLabel.Caption := 'Saving a backup of your shop data ...';
    if Exec(exe, '--backup', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, code) and (code = 0) then
      BackupTaken := True
    else
    begin
      Result := 'Twisha POS could not save a backup of your shop data, so nothing has been changed.' + #13#10#13#10 +
                'Your data is safe. Close Twisha POS (tray icon near the clock - Quit), make sure the backup drive is plugged in, and run this installer again.' + #13#10 +
                'If it keeps failing, send the file ' + DataDir() + '\logs\setup.log to support.';
      Exit;
    end;
  end;
  StopRunningCopy();
end;

// Data from an earlier installation that was uninstalled: the old program is gone, so the backup is taken with the new one, once it is in place.
procedure CurStepChanged(CurStep: TSetupStep);
var
  code: Integer;
begin
  if (CurStep = ssPostInstall) and (not BackupTaken) and HasShopData() then
    if Exec(ExpandConstant('{app}\TwishaPOS.exe'), '--backup', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, code) and (code = 0) then
      BackupTaken := True;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and BackupTaken then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
      'A backup of your shop data was saved before updating (Documents\TwishaPOS Backups, or the folder chosen in Backup settings).';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('Twisha POS has been removed from this computer.' + #13#10#13#10 +
           'Your shop data and backups were NOT deleted:' + #13#10 +
           '  ' + ExpandConstant('{localappdata}\TwishaPOS') + #13#10 +
           '  ' + ExpandConstant('{userdocs}\TwishaPOS Backups') + #13#10#13#10 +
           'Install again later and everything comes back.', mbInformation, MB_OK);
end;
