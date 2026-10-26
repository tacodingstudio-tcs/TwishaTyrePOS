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

#define AppName "Twisha POS"

[Setup]
AppId={{6C2E0D8A-7B1F-4F5E-9A3C-5A1D2E7B9C41}
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

[Run]
Filename: "{app}\TwishaPOS.exe"; Description: "Start Twisha POS now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\TwishaPOS.exe"; Parameters: "--stop"; WorkingDir: "{app}"; RunOnceId: "StopTwishaPOS"; Flags: waituntilterminated

[Code]
// An upgrade over a running copy: stop it first (this also takes a backup), so no file is in use.
function StopRunningCopy(): Boolean;
var
  exe: String;
  code: Integer;
begin
  Result := True;
  exe := ExpandConstant('{app}\TwishaPOS.exe');
  if FileExists(exe) then
    Exec(exe, '--stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningCopy();
  Result := '';
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
